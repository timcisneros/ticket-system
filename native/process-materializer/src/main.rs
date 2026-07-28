use std::env;
use std::process::ExitCode;

use ticket_system_process_materializer::{MaterializerService, ServiceConfig};

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 2 {
        eprintln!("usage: ticket-system-process-materializer <trusted-config.json>");
        return ExitCode::from(64);
    }
    let config = match ServiceConfig::load(&arguments[1]) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "materializer configuration failed: {}: {}",
                error.code, error.message
            );
            return ExitCode::from(78);
        }
    };
    match MaterializerService::new(config).and_then(MaterializerService::serve) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "materializer service failed: {}: {}",
                error.code, error.message
            );
            ExitCode::from(70)
        }
    }
}
