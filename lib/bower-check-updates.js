var program = require('commander');
var async = require('async');
var cint = require('cint');
var path = require('path');
var vm = require('./versionmanager');
var closestBower = require('closest-bower');
var _ = require('lodash');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var stdin = require('get-stdin-promise');
var readJson = Promise.promisify(require('read-package-json'));

//
// Helper functions
//

var print = program.silent ? _.noop : console.log;
var readPackageFile = cint.partialAt(fs.readFileAsync, 1, 'utf8');
var writePackageFile = fs.writeFileAsync;

//
// Main functions
//

function upgradePackageDefinitions(currentDependencies) {
    var dependencyList = Object.keys(currentDependencies);
    return vm.getLatestVersions(dependencyList, {
        versionTarget: program.greatest ? 'greatest' : 'latest',
        registry: program.registry ? program.registry : null,
    }).then(function (latestVersions) {
        var upgradedDependencies = vm.upgradeDependencies(currentDependencies, latestVersions);
        return [upgradedDependencies, latestVersions];
    });
}

function analyzeGlobalPackages() {
    return vm.getInstalledPackages()
        .then(function (globalPackages) {
            return upgradePackageDefinitions(globalPackages)
                .spread(function (upgraded, latest) {
                    printGlobalUpgrades(globalPackages, upgraded)
                });
        });
}

function analyzeProjectDependencies(pkgData, pkgFile) {
    var options = _.pick(program, ['filter', 'prod', 'dev']);
    var pkg = JSON.parse(pkgData);
    var current = vm.getCurrentDependencies(pkg, options);

    return Promise.all([
        current,
        // only search for installed dependencies if a pkgFile is specified
        pkgFile ? vm.getInstalledPackages() : Promise.resolve(null),
        upgradePackageDefinitions(current)
    ])
        .spread(function (current, installed, upgradedAndLatest) {
            return [current, installed, upgradedAndLatest[0], upgradedAndLatest[1]];
        })
        .spread(function (current, installed, upgraded, latest) {
            var newPkgData;
            if (program.json) {
                newPkgData = vm.updatePackageData(pkgData, current, upgraded);
                print(program.jsonAll ? JSON.parse(newPkgData) :
                        program.jsonDeps ? _.pick(JSON.parse(newPkgData), 'dependencies', 'devDependencies') :
                            upgraded
                );
            }
            else {
                printLocalUpgrades(current, upgraded, installed, latest);

                if (pkgFile && !_.isEmpty(upgraded)) {
                    if (program.upgrade) {
                        newPkgData = vm.updatePackageData(pkgData, current, upgraded);
                        writePackageFile(pkgFile, newPkgData)
                            .then(function () {
                                print('\n' + pkgFile + " upgraded");
                            });
                    } else {
                        print("Run with '-u' to upgrade your bower.json");
                    }
                    if (program.errorLevel >= 2) {
                        throw new Error('Dependencies not up-to-date');
                    }
                }
            }
        });
}

function printGlobalUpgrades(current, upgraded) {
    print('');
    if (_.isEmpty(upgraded)) {
        print("All global packages are up to date :)");
    } else {
        for (var dep in upgraded) {
            if (upgraded.hasOwnProperty(dep)) {
                print('"' + dep + '" can be updated from ' +
                    current[dep] + ' to ' + upgraded[dep]);
            }
        }
        if (program.errorLevel >= 2) {
            throw new Error('Dependencies not up-to-date');
        }
    }
    print('');
}

function printLocalUpgrades(current, upgraded, installed, latest) {
    print('');
    var superlative = program.greatest ? "Greatest" : "Latest";
    if (_.isEmpty(upgraded)) {
        print("All dependencies match the " + superlative.toLowerCase() + " package versions :)");
    } else {
        for (var dep in upgraded) {
            if (upgraded.hasOwnProperty(dep)) {
                var installedMessage = installed ? "Installed: " + (installed[dep] ? installed[dep] : "none") + ", " : '';
                var latestOrGreatestMessage = superlative + ": " + latest[dep];
                var message = '"' + dep + '" can be updated from ' +
                    current[dep] + ' to ' + upgraded[dep] + " (" + installedMessage + latestOrGreatestMessage + ")";
                print(message);
            }
        }
    }
    print('');
}

//
// Program
//


function programInit() {

    var execName = path.basename(process.argv[1]);
    if (execName === 'bower-check-updates') {
        print('You can now use the alias "bcu" for less typing!');
    }

    if (program.global && program.upgrade) {
        print("bower-check-updates cannot update global packages.");
        print("Run 'npm install -g [package]' to upgrade a global package.");
        process.exit(1);
    }

    // add shortcut for any keys that start with 'json'
    program.json = _(program)
        .keys()
        .filter(_.partial(_.startsWith, _, 'json', 0))
        .some(_.propertyOf(program));
}

function programRun() {
    programInit();
    program.global ?
        programRunGlobal() :
        programRunLocal()
}

function programRunGlobal() {
    return analyzeGlobalPackages();
}

function programRunLocal() {

    var packageFile = 'package.json';
    var json;

    if (!process.stdin.isTTY) {
        pkgData = stdin;
        pkgFile = null; // this signals analyzeProjectDependencies to search for installed dependencies and to not print the upgrade message
    }
    else {
        // Check if a file or directory was specified on the command line
        if (program.args[0] && fs.existsSync(program.args[0])) {
            if (path.basename(program.args[0]) === pkgFile)
                pkgFile = program.args[0];
            else if (fs.statSync(program.args[0]).isDirectory())
                pkgFile = path.join(program.args[0], pkgFile);
        } else if (program.args[0]) {
            throw new Error(program.args[0] + " is not a valid file or directory");
        } else {
            pkgFile = closestBower.sync(process.cwd());
            packageInSameDir = false;
        }

        var relPathToPackage = path.relative(process.cwd(), pkgFile);

        if (!fs.existsSync(pkgFile)) {
            throw new Error('package.json not found');
        }

        // print a message if we are using a descendant package.json
        if (relPathToPackage !== 'package.json') {
            print('Using ' + relPathToPackage);
        }

        pkgData = readPackageFile(pkgFile, null, false);
    }

    return pkgData.then(_.partialRight(analyzeProjectDependencies, _, pkgFile));
}

program
    .version(require('../package').version)
    .usage('[options] <package.json or dir>')
    .option('-d, --dev', 'check only devDependencies')
    .option('-e, --error-level <n>', 'set the error-level. 1: exits with error code 0 if no errors occur. 2: exits with error code 0 if no packages need updating (useful for continuous integration). Default is 1.', cint.partialAt(parseInt, 1, 10), 1)
    .option('-f, --filter <packages>', 'list or regex of package names to search (all others will be ignored). Note: single quotes may be required to avoid inadvertant bash parsing.')
    .option('-g, --global', 'check global packages instead of in the current project')
    // program.json is set to true in programInit if any options that begin with 'json' are true
    .option('-j, --jsonAll', 'output new package.json instead of human-readable message')
    .option('--jsonUpgraded', 'output upgraded dependencies in json')
    .option('-p, --prod', 'check only dependencies (not devDependencies)')
    .option('--registry <url>', 'specify third-party npm registry')
    .option('-s, --silent', "don't output anything")
    .option('-t, --greatest', "find the highest versions available instead of the latest stable versions")
    .option('-u, --upgrade', 'upgrade package.json dependencies to match latest versions (maintaining existing policy)')
    .parse(process.argv);

vm.initialize(program.global).then(programRun);

