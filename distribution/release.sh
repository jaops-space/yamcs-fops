#!/bin/bash
# Releases the Yamcs plugin (plugin/) to Maven Central, from a clean clone of
# the committed tree with the web UI built into the jar. The tag v<version>
# also releases the Python package yamcs-fops to PyPI once pushed (the CI
# workflow python.yml), so Cargo.toml gets the same version.
set -e

cd `dirname $0`/..
home=`pwd`

if [[ -n $(git status -s) ]]; then
    read -p 'Your workspace contains dirty or untracked files. These will not be part of your release. Continue? [Y/n] ' yesNo
    if [[ -n $yesNo ]] && [[ $yesNo == 'n' ]]; then
        exit 0
    fi
fi

# The plugin's version, also in dev/yamcs/pom.xml (its yamcs-fops dependency)
setversion() {
    mvn -q -f plugin versions:set -DnewVersion=$1 versions:commit
    sed -i "/<artifactId>yamcs-fops<\/artifactId>/{n;s|<version>.*</version>|<version>$1</version>|}" dev/yamcs/pom.xml
}

pomversion=`mvn -q -f plugin help:evaluate -Dexpression=project.version -DforceStdout`
read -p "Enter the new version to set [$pomversion] " newVersion
if [[ -n $newVersion ]]; then
    pomversion=$newVersion
    setversion $newVersion
fi

if [[ $pomversion == *-SNAPSHOT ]]; then
    snapshot=1
    version=${pomversion/-SNAPSHOT/}
else
    snapshot=0
    version=$pomversion
    sed -i "0,/^version = /s/^version = \".*\"/version = \"$version\"/" Cargo.toml
    cargo update -w --offline -q
fi

if [[ -n $(git status -s) ]]; then
    git commit . -v -em"Prepare release yamcs-fops-${version}" || :
fi
if [ $snapshot -eq 0 ]; then
    if git rev-parse -q --verify refs/tags/v$version >/dev/null; then
        echo "Tag v$version exists already (the Python package of this version): not moved"
    else
        git tag v$version
    fi
fi

clonedir=$home/distribution/target/yamcs-fops-clone

rm -rf $clonedir
mkdir -p $clonedir
git clone . $clonedir
rm -rf $clonedir/.git

cd $clonedir

# The web UI, packed into the jar by the plugin's build
(cd web && npm ci && npm run build)
mvn -f plugin package -P jaops-release -DskipTests

cd $home

ls -lh $clonedir/plugin/target/*.jar
echo

if [ $snapshot -eq 0 ]; then
    read -p "Do you want to upload $pomversion maven artifacts to Maven Central? [y/N] " yesNo
    if [[ $yesNo == 'y' ]]; then
        mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy
        echo 'Check and publish the deployment at https://central.sonatype.com/publishing/deployments'
    fi
else
    # Requires SNAPSHOTs to be enabled for the com.jaops namespace in the Central Portal
    read -p "Do you want to publish $pomversion maven artifacts to Maven Central Snapshots? [y/N] " yesNo
    if [[ $yesNo == 'y' ]]; then
        mvn -f $clonedir/plugin -P jaops-release -DskipTests deploy
    fi
fi

rm -rf $clonedir

# Upgrade version in pom.xml files
# For example: 1.2.3 --> 1.2.4-SNAPSHOT
if [ $snapshot -eq 0 ]; then
    if [[ $version =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        developmentVersion=${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))-SNAPSHOT
        setversion $developmentVersion
        git commit . -v -em"Prepare next development iteration"
    else
        echo 'Failed to set development version'
        exit 1
    fi
    echo "Then: git push origin main v$version (the tag publishes the Python package, if new)"
fi
