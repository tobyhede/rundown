#![deny(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("rd-landlock {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    eprintln!("rd-landlock: no spec provided");
    std::process::exit(2);
}
