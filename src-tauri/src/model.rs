use serde::{Deserialize,Serialize};
use std::{collections::HashSet, path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};

#[derive(Clone,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub struct Service { pub id:String, pub name:String, pub directory:String, pub command:String }
#[derive(Clone,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub struct Project { pub id:String, pub name:String, pub root:String, pub services:Vec<Service> }
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Config { pub version:u32, pub bash_path:String, pub projects:Vec<Project> }
impl Default for Config { fn default()->Self { Self { version:1,bash_path:String::new(),projects:vec![] } } }
pub fn now()->u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub fn directory(path:impl AsRef<Path>)->Result<PathBuf,String> {
    let path=path.as_ref();
    if !path.is_dir() { return Err(format!("Directory does not exist: {}",path.display())); }
    // Avoid extended-length \\?\ paths, which MSYS/Git Bash cannot interpret.
    let canonical=std::fs::canonicalize(path).map_err(|e|e.to_string())?;
    let value=canonical.to_string_lossy();
    Ok(PathBuf::from(if let Some(p)=value.strip_prefix("\\\\?\\UNC\\") {format!("\\\\{p}")}else{value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()}))
}
pub fn service_directory(project:&Project,service:&Service)->Result<PathBuf,String> {
    let p=Path::new(&service.directory); directory(if p.is_absolute(){p.to_path_buf()}else{Path::new(&project.root).join(p)})
}
impl Config {
    pub fn validate(&self)->Result<(),String> {
        if self.version!=1 { return Err("Unsupported configuration version".into()); }
        let mut ids=HashSet::new();
        for p in &self.projects {
            if p.id.is_empty() || !ids.insert(&p.id) || p.name.trim().is_empty() || p.root.is_empty() { return Err("Projects require unique IDs, a name, and a root directory".into()); }
            for s in &p.services {
                if s.id.is_empty() || !ids.insert(&s.id) || s.name.trim().is_empty() || s.command.trim().is_empty() { return Err("Services require unique IDs, a name, and a startup command".into()); }
                if s.command.contains('\0') || s.command.len()>24000 { return Err("Startup command is invalid or too long (24 KB maximum)".into()); }
            }
        } Ok(())
    }
}
pub fn find_bash(custom:&str)->Option<PathBuf> {
    if !custom.trim().is_empty() { return valid_bash(PathBuf::from(custom)); }
    let mut candidates=vec![];
    for base in [std::env::var_os("ProgramW6432"),std::env::var_os("ProgramFiles"),std::env::var_os("ProgramFiles(x86)")] .into_iter().flatten() {
        candidates.push(PathBuf::from(base).join("Git/bin/bash.exe"));
    }
    if let Some(local)=std::env::var_os("LOCALAPPDATA") { candidates.push(PathBuf::from(local).join("Programs/Git/bin/bash.exe")); }
    if let Some(path)=std::env::var_os("PATH") { for p in std::env::split_paths(&path) {
        candidates.push(p.join("bash.exe")); candidates.push(p.join("../bin/bash.exe")); candidates.push(p.join("../../bin/bash.exe"));
    } }
    candidates.into_iter().find_map(valid_bash)
}
fn valid_bash(p:PathBuf)->Option<PathBuf> {
    if !p.is_file() || !p.file_name()?.to_string_lossy().eq_ignore_ascii_case("bash.exe") { return None; }
    let parent=p.parent()?;
    // Git for Windows includes usr/bin/msys-2.0.dll. This rejects WSL's bash.exe.
    let actual=if parent.join("msys-2.0.dll").is_file(){p.clone()}else{parent.join("../usr/bin/bash.exe")};
    let bin=actual.parent()?;let root=bin.parent()?.parent()?;
    if !actual.is_file() || !bin.join("msys-2.0.dll").is_file() || !(root.join("cmd/git.exe").is_file()||root.join("mingw64/bin/git.exe").is_file()||root.join("mingw32/bin/git.exe").is_file()) {return None;}
    // Bypass Git's bin/bash.exe launcher and spawn the real MSYS bash directly.
    let actual=std::fs::canonicalize(actual).ok()?;
    let value=actual.to_string_lossy();
    Some(PathBuf::from(if let Some(p)=value.strip_prefix("\\\\?\\UNC\\"){format!("\\\\{p}")}else{value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()}))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn reject_duplicate_service_ids() {
        let mut c=Config::default(); let s=Service{id:"s".into(),name:"Web".into(),directory:".".into(),command:"npm run dev".into()};
        c.projects.push(Project{id:"p".into(),name:"Demo".into(),root:"C:\\demo".into(),services:vec![s.clone(),s]});
        assert!(c.validate().is_err());
    }
    #[test] fn missing_directory_is_actionable() { assert!(directory("Z:\\prorun-nonexistent-path").unwrap_err().contains("Directory does not exist")); }
    #[test] fn detect_real_git_bash() { assert!(find_bash("").is_some()); }
}
