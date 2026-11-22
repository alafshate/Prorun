// Native test double for the existing Codex app-server protocol. No real CLI,
// account, provider configuration, or running session is used by lifecycle tests.
use std::io::{self, BufRead, Write};
use std::{fs, path::PathBuf, time::Duration};
fn main() {
    let home = PathBuf::from(std::env::var_os("CODEX_HOME").unwrap());
    let mut calls = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("calls"))
        .unwrap();
    writeln!(calls, "{}", std::process::id()).unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.contains("initialize\"") {
            println!("{{\"id\":1,\"result\":{{}}}}");
        } else if line.contains("account/rateLimits/read") {
            if home.join("block").exists() {
                fs::write(home.join("pending"), std::process::id().to_string()).unwrap();
                std::thread::sleep(Duration::from_secs(60));
            }
            println!("{{\"id\":2,\"result\":{{\"rateLimits\":{{\"primary\":{{\"windowDurationMins\":300,\"usedPercent\":90,\"resetsAt\":9999999999}}}}}}}}");
        }
        io::stdout().flush().unwrap();
    }
}
