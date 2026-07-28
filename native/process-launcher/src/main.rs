use std::env;
use std::process::ExitCode;

use ticket_system_process_launcher_foundation::{FoundationService, ServiceConfig};

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 2 {
        eprintln!("usage: ticket-system-process-launcher-foundation <trusted-config.json>");
        return ExitCode::from(64);
    }
    let config = match ServiceConfig::load(&arguments[1]) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "launcher foundation configuration failed: {}: {}",
                error.code, error.message
            );
            return ExitCode::from(78);
        }
    };
    match FoundationService::new(config).and_then(FoundationService::serve) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "launcher foundation service failed: {}: {}",
                error.code, error.message
            );
            ExitCode::from(70)
        }
    }
}
