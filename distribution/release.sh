#!/bin/bash
# Releases yamcs-fops from this machine (docs/releasing.md): one version for
#   maven   the Yamcs plugin com.jaops.yamcs:yamcs-fops, to Maven Central
#   pypi    the Python package yamcs-fops (the worker), to PyPI
#   vscode  the VS Code extension jaops.fops-vscode, to the Marketplace
#
#   distribution/release.sh [maven] [pypi] [vscode]      (none given: all three)
#
# It sets the version everywhere, commits, builds everything from a clean
# clone of that commit, tags it v<version>, asks before each upload, then sets the
# next -SNAPSHOT version and asks before pushing main and the tag. A -SNAPSHOT
# version only goes to Maven Central Snapshots: no tag, no Python package or
# extension.
set -e

cd `dirname $0`/..
home=`pwd`
target=$home/distribution/target
venv=$target/venv

maven=0 pypi=0 vscode=0
for a in "${@:-maven pypi vscode}"; do
    for w in $a; do
        case $w in
        maven) maven=1 ;;
        pypi) pypi=1 ;;
        vscode) vscode=1 ;;
        *) echo "usage: $0 [maven] [pypi] [vscode]"; exit 1 ;;
        esac
    done
done

ask() { # ask "question" -> 0 on y
    local yesNo
    read -p "$1 [y/N] " yesNo
    [[ $yesNo == 'y' ]]
}

if [[ -n $(git status -s) ]]; then
    read -p 'Your workspace contains dirty or untracked files. These will not be part of your release. Continue? [Y/n] ' yesNo
    if [[ $yesNo == 'n' ]]; then
        exit 0
    fi
fi

# --- the version -----------------------------------------------------------------------------------------------

pomversion=`mvn -q -f plugin help:evaluate -Dexpression=project.version -DforceStdout`
released=`sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1`
read -p "Enter the version to release [${pomversion/-SNAPSHOT/}] " version
version=${version:-${pomversion/-SNAPSHOT/}}
if [[ $version == *-SNAPSHOT ]]; then
    snapshot=1
    if [ $pypi -eq 1 ] || [ $vscode -eq 1 ]; then
        echo "$version: a snapshot, for Maven Central Snapshots only (not PyPI nor the Marketplace)"
        pypi=0 vscode=0
    fi
    maven=1
elif [[ $version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    snapshot=0
    next=${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))-SNAPSHOT
    if git rev-parse -q --verify refs/tags/v$version >/dev/null; then
        echo "Tag v$version exists already: give a version not released yet"
        exit 1
    fi
else
    echo "$version: not a version (1.2.3 or 1.2.3-SNAPSHOT)"
    exit 1
fi

# --- what each upload needs, before anything changes --------------------------------------------------------------

missing=()
if [ $maven -eq 1 ]; then
    gpg --list-secret-keys C56E028076F3CCB9 >/dev/null 2>&1 || missing+=("the Jaops signing key C56E028076F3CCB9 in GPG")
    grep -q '<id>central-jaops</id>' ~/.m2/settings.xml 2>/dev/null || missing+=("the server central-jaops in ~/.m2/settings.xml")
    command -v npm >/dev/null || missing+=("npm (the web UI)")
fi
if [ $pypi -eq 1 ]; then
    rustup target list --installed | grep -q aarch64-unknown-linux-gnu \
        || missing+=("the Rust target aarch64: rustup target add aarch64-unknown-linux-gnu")
    if [[ -z $TWINE_PASSWORD ]] && ! grep -q '^\[pypi\]' ~/.pypirc 2>/dev/null; then
        missing+=("a PyPI API token: [pypi] in ~/.pypirc, or TWINE_PASSWORD")
    fi
fi
if [ $vscode -eq 1 ]; then
    command -v npm >/dev/null || missing+=("npm (the extension)")
fi
if [ ${#missing[@]} -gt 0 ]; then
    printf 'Missing:\n'
    printf '  - %s\n' "${missing[@]}"
    exit 1
fi

# --- set it everywhere, commit ------------------------------------------------------------------------------

# the plugin's, also in dev/yamcs/pom.xml (its yamcs-fops dependency)
setpom() {
    mvn -q -f plugin versions:set -DnewVersion=$1 versions:commit
    sed -i "/<artifactId>yamcs-fops<\/artifactId>/{n;s|<version>.*</version>|<version>$1</version>|}" dev/yamcs/pom.xml
}

setpom $version
if [ $snapshot -eq 0 ]; then
    # the Python package's version is the crate's
    sed -i "0,/^version = /s/^version = \".*\"/version = \"$version\"/" Cargo.toml
    cargo update -w --offline -q
    (cd vscode && npm version $version --no-git-tag-version --allow-same-version >/dev/null)
    # the install instructions name the latest release
    if [[ $released != $version ]]; then
        r=${released//./\\.}
        sed -i -e "/<artifactId>yamcs-fops<\/artifactId>/{n;s|<version>$r</version>|<version>$version</version>|}" \
            -e "s|yamcs-fops-$r\.jar|yamcs-fops-$version.jar|g; s|/yamcs-fops/$r/|/yamcs-fops/$version/|g" README.md
        sed -i "s|fops-vscode-$r\.vsix|fops-vscode-$version.vsix|g" vscode/README.md
    fi
fi
if [[ -n $(git status -s) ]]; then
    git commit -aqm "Release yamcs-fops-$version"
fi

# --- build, from a clean clone of that commit, then tag it -------------------------------------------------------------------

clonedir=$target/yamcs-fops-$version
rm -rf $clonedir
git clone -q . $clonedir
rm -rf $clonedir/.git
cd $clonedir

if [ $maven -eq 1 ]; then
    # the web UI, packed into the jar by the plugin's build
    (cd web && npm ci && npm run build)
    mvn -f plugin package -P jaops-release -DskipTests
fi

if [ $pypi -eq 1 ]; then
    if [[ ! -x $venv/bin/maturin ]]; then
        python3 -m venv $venv
        $venv/bin/pip -q install "maturin[zig]>=1.9,<2" twine
    fi
    export PATH=$venv/bin:$PATH # maturin runs zig from there
    # the sdist first, from the sources alone
    $venv/bin/maturin sdist --out dist
    # One wheel per CPython (the worker uses APIs outside the stable ABI) and
    # architecture; zig links against glibc 2.28, for manylinux_2_28.
    for arch in x86_64 aarch64; do
        $venv/bin/maturin build --release --zig --target $arch-unknown-linux-gnu --compatibility manylinux_2_28 \
            -i python3.12 python3.13 python3.14 --out dist
    done
    $venv/bin/twine check dist/*
fi

if [ $vscode -eq 1 ]; then
    (cd vscode && npm ci && npm run compile && npx vsce package -o fops-vscode-$version.vsix)
fi

cd $home
if [ $snapshot -eq 0 ]; then
    git tag v$version
fi

echo
[ $maven -eq 1 ] && ls -lh $clonedir/plugin/target/*.jar
[ $pypi -eq 1 ] && ls -lh $clonedir/dist
[ $vscode -eq 1 ] && ls -lh $clonedir/vscode/*.vsix
echo

# --- upload, each on confirmation ------------------------------------------------------------------------------

later=()
if [ $maven -eq 1 ]; then
    where='Maven Central'
    [ $snapshot -eq 1 ] && where='Maven Central Snapshots'
    if ask "Upload the plugin $version to $where?"; then
        mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy
        [ $snapshot -eq 0 ] && echo 'Then publish the deployment at https://central.sonatype.com/publishing/deployments'
    else
        later+=("mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy")
    fi
fi
if [ $pypi -eq 1 ]; then
    if ask "Upload the Python package $version to PyPI?"; then
        $venv/bin/twine upload $clonedir/dist/*
    else
        later+=("$venv/bin/twine upload $clonedir/dist/*")
    fi
fi
if [ $vscode -eq 1 ]; then
    if ask "Publish the VS Code extension $version to the Marketplace?"; then
        (cd $clonedir/vscode && npx vsce publish --packagePath fops-vscode-$version.vsix)
    else
        later+=("(cd $clonedir/vscode && npx vsce publish --packagePath fops-vscode-$version.vsix)")
    fi
fi

# --- next development iteration, push ----------------------------------------------------------------------------

if [ $snapshot -eq 0 ]; then
    setpom $next
    git commit -aqm "Prepare next development iteration"
    if ask "Push main and v$version to origin?"; then
        git push origin main v$version
    else
        later+=("git push origin main v$version")
    fi
fi

if [ ${#later[@]} -gt 0 ]; then
    echo
    echo "Not done; the builds stay in $clonedir:"
    printf '  %s\n' "${later[@]}"
else
    rm -rf $clonedir
fi
