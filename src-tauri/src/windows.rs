//! Windows process ownership. Every service is suspended until assigned to its
//! kill-on-close Job Object, so even very short-lived launchers cannot escape.
use std::{ffi::OsStr, fs::File, mem::{size_of, zeroed}, os::windows::{ffi::OsStrExt, io::FromRawHandle}, path::Path, ptr::null_mut};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, Storage::FileSystem::*, System::{JobObjects::*, Pipes::CreatePipe, Threading::*}};

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> { value.as_ref().encode_wide().chain(Some(0)).collect() }
fn last() -> String { std::io::Error::last_os_error().to_string() }

pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

pub struct Job(Handle);
impl Job {
    pub fn new() -> Result<Self,String> { unsafe {
        let h = CreateJobObjectW(null_mut(), std::ptr::null());
        if h.is_null() { return Err(last()); }
        let job = Self(Handle(h));
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 { return Err(last()); }
        Ok(job)
    } }
    pub fn assign(&self, process: HANDLE) -> Result<(),String> { unsafe {
        if AssignProcessToJobObject(self.0.0, process) == 0 { Err(last()) } else { Ok(()) }
    } }
    pub fn assign_pid(&self, pid: u32) -> Result<(),String> { unsafe {
        let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if h.is_null() { return Err(last()); }
        let owned = Handle(h); self.assign(owned.0)
    } }
    pub fn terminate(&self) { unsafe { TerminateJobObject(self.0.0, 1); } }
    #[cfg(test)]
    pub fn active_processes(&self)->u32 {unsafe{
        let mut info:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=zeroed();
        assert_ne!(QueryInformationJobObject(self.0.0,JobObjectBasicAccountingInformation,&mut info as *mut _ as _,size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,null_mut()),0);
        info.ActiveProcesses
    }}
}

pub struct Process { pub handle: Handle, pub job: Job }
impl Process {
    pub fn wait(&self) -> i32 { unsafe {
        WaitForSingleObject(self.handle.0, INFINITE);
        let mut code = 1; GetExitCodeProcess(self.handle.0, &mut code); code as i32
    } }
    pub fn stop(&self) { self.job.terminate(); unsafe { WaitForSingleObject(self.handle.0, 5000); } }
}

// CommandLineToArgvW-compatible quoting. Service source is passed unchanged as
// ONE bash -c argument; neither cmd.exe nor PowerShell is involved.
pub fn quote(value: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' { slashes += 1; continue; }
        if c == '"' { result.push_str(&"\\".repeat(slashes * 2 + 1)); }
        else { result.push_str(&"\\".repeat(slashes)); }
        result.push(c); slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2)); result.push('"'); result
}

unsafe fn pipe() -> Result<(Handle,Handle),String> {
    let mut read = null_mut(); let mut write = null_mut();
    let attr = SECURITY_ATTRIBUTES { nLength:size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor:null_mut(), bInheritHandle:1 };
    if CreatePipe(&mut read,&mut write,&attr,0) == 0 { return Err(last()); }
    let read = Handle(read); let write = Handle(write);
    if SetHandleInformation(read.0,HANDLE_FLAG_INHERIT,0) == 0 { return Err(last()); }
    Ok((read,write))
}

pub fn spawn(bash: &Path, cwd: &Path, source: &str) -> Result<(Process,File,File),String> { unsafe {
    let job = Job::new()?;
    let (out_read,out_write) = pipe()?; let (err_read,err_write) = pipe()?;
    let attr = SECURITY_ATTRIBUTES { nLength:size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor:null_mut(), bInheritHandle:1 };
    let input = CreateFileW(wide("NUL").as_ptr(),GENERIC_READ,FILE_SHARE_READ | FILE_SHARE_WRITE,&attr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,null_mut());
    if input == INVALID_HANDLE_VALUE { return Err(last()); }
    let input = Handle(input);
    // Explicit inheritance prevents an unrelated service/PTY from retaining a
    // pipe's write handle and keeping another service's log reader alive.
    let mut attribute_size=0;
    InitializeProcThreadAttributeList(null_mut(),1,0,&mut attribute_size);
    let mut storage=vec![0usize;attribute_size.div_ceil(size_of::<usize>())];
    let attributes=storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if InitializeProcThreadAttributeList(attributes,1,0,&mut attribute_size)==0{return Err(last());}
    struct AttributeGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for AttributeGuard{fn drop(&mut self){unsafe{DeleteProcThreadAttributeList(self.0);}}}
    let _attribute_guard=AttributeGuard(attributes);
    let handles=[input.0,out_write.0,err_write.0];
    if UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,handles.as_ptr() as _,std::mem::size_of_val(&handles),null_mut(),null_mut())==0{return Err(last());}
    let mut si: STARTUPINFOEXW = zeroed(); si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList=attributes;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES; si.StartupInfo.hStdOutput = out_write.0; si.StartupInfo.hStdError = err_write.0; si.StartupInfo.hStdInput = input.0;
    let mut pi: PROCESS_INFORMATION = zeroed();
    let mut command = wide(format!("{} --noprofile --norc -c {}",quote(&bash.to_string_lossy()),quote(source)));
    // Keep Git tools on PATH and npm's script shell consistent with Git Bash.
    let mut env: Vec<(String,String)> = std::env::vars().filter(|(k,_)| !["CHERE_INVOKING","MSYSTEM","TERM","BASH_ENV","ENV","PATH","NPM_CONFIG_SCRIPT_SHELL"].contains(&k.to_uppercase().as_str())).collect();
    env.extend([("CHERE_INVOKING".into(),"1".into()),("MSYSTEM".into(),"MINGW64".into()),("TERM".into(),"xterm-256color".into())]);
    let git_root=bash.parent().unwrap().parent().unwrap().parent().unwrap();
    env.push(("PATH".into(),format!("{};{};{};{}",git_root.join("mingw64/bin").display(),git_root.join("usr/bin").display(),git_root.join("bin").display(),std::env::var("PATH").unwrap_or_default())));
    env.push(("npm_config_script_shell".into(),bash.to_string_lossy().into_owned()));
    env.sort_by_key(|(k,_)| k.to_uppercase());
    let mut block: Vec<u16> = env.iter().flat_map(|(k,v)|wide(format!("{k}={v}"))).collect(); block.push(0);
    if CreateProcessW(wide(bash).as_ptr(),command.as_mut_ptr(),null_mut(),null_mut(),1,CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,block.as_ptr() as _,wide(cwd).as_ptr(),&si.StartupInfo,&mut pi) == 0 { return Err(last()); }
    let process = Handle(pi.hProcess); let thread = Handle(pi.hThread);
    if let Err(e) = job.assign(process.0) { TerminateProcess(process.0,1); return Err(format!("Cannot contain process tree: {e}")); }
    if ResumeThread(thread.0) == u32::MAX { job.terminate(); return Err(last()); }
    let out = File::from_raw_handle(out_read.0 as _); std::mem::forget(out_read);
    let err = File::from_raw_handle(err_read.0 as _); std::mem::forget(err_read);
    Ok((Process { handle:process,job },out,err))
} }

pub fn replace(from:&Path,to:&Path) -> Result<(),String> { unsafe {
    if MoveFileExW(wide(from).as_ptr(),wide(to).as_ptr(),MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0 { Err(last()) } else { Ok(()) }
} }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn windows_arguments() {
        assert_eq!(quote("hello world"),"\"hello world\"");
        assert_eq!(quote("a\"b"),"\"a\\\"b\"");
        assert_eq!(quote("C:\\space here\\"),"\"C:\\space here\\\\\"");
    }
}
