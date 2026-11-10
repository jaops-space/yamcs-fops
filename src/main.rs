fn main() -> anyhow::Result<()> {
    std::process::exit(fops::cli(std::env::args_os())?)
}
