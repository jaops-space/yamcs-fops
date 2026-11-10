// Debian/Ubuntu ship libpython3.X.so.1.0 without the unversioned dev symlink
// unless python3-dev is installed. PyO3 links with -lpython3.X, so provide the
// symlink in OUT_DIR when it is missing.
use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PYO3_BUILD_EXTENSION_MODULE");
    // The Python extension (maturin) does not link libpython.
    if env::var_os("PYO3_BUILD_EXTENSION_MODULE").is_some() {
        return;
    }
    let out = Command::new(env::var("PYO3_PYTHON").unwrap_or_else(|_| "python3".into()))
        .args(["-c", "import sysconfig as s; print(s.get_config_var('LIBDIR')); print(s.get_config_var('LDLIBRARY')); print(s.get_config_var('INSTSONAME'))"])
        .output()
        .expect("python3 not found");
    let text = String::from_utf8(out.stdout).unwrap();
    let mut lines = text.lines();
    let (libdir, ldlib, soname) = (lines.next().unwrap(), lines.next().unwrap(), lines.next().unwrap());
    let dev = PathBuf::from(libdir).join(ldlib);
    if !dev.exists() {
        let dir = PathBuf::from(env::var("OUT_DIR").unwrap()).join("pylib");
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join(ldlib);
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(PathBuf::from(libdir).join(soname), &link).unwrap();
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
}
