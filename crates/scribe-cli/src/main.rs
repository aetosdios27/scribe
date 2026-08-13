mod app;
mod cli;
mod engine;
mod protocol;
mod terminal;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> std::process::ExitCode {
    app::run()
}
