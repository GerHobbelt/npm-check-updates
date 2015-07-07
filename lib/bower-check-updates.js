var options = {};

//
// Dependencies
//

var async = require('async');
var cint = require('cint');
var path = require('path');
var closestPackage = require('closest-package');
var _ = require('lodash');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var vm = require('./versionmanager');

//
// Helper functions
//

function print(message) {
    if (!options.silent) {
       console.log(message);
    }
}

var readPackageFile = cint.partialAt(fs.readFileAsync, 1, 'utf8');
var writePackageFile = fs.writeFileAsync;

//
// Main functions
//

function upgradePackageDefinitions(currentDependencies) {
    var dependencyList = Object.keys(currentDependencies);
    return vm.getLatestVersions(dependencyList, {
        versionTarget: options.greatest ? 'greatest' : 'latest',
        registry: options.registry ? options.registry : null,
    }).then(function (latestVersions) {
        var upgradedDependencies = vm.upgradeDependencies(currentDependencies, latestVersions, { force: options.force });
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
    var pkg = JSON.parse(pkgData);
    var current = vm.getCurrentDependencies(pkg, {
        prod: options.prod,
        dev: options.dev,
        filter: options.args[0]
    });

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

        if(options.json) {
            var newPkgData = vm.updatePackageData(pkgData, current, upgraded);
            print(options.jsonAll ? JSON.parse(newPkgData) :
                options.jsonDeps ? _.pick(JSON.parse(newPkgData), 'dependencies', 'devDependencies') :
                upgraded
            );
        }
        else {
            printLocalUpgrades(current, upgraded, installed, latest);

            if(pkgFile && !_.isEmpty(upgraded)) {
                if (options.upgrade) {
                    var newPkgData = vm.updatePackageData(pkgData, current, upgraded);
                    writePackageFile(pkgFile, newPkgData)
                        .then(function () {
                            print('\n' + pkgFile + " upgraded");
                        });
                } else {
                    print("Run with '-u' to upgrade your bower.json");
                }
                if(options.errorLevel >= 2) {
                    throw new Error('Dependencies not up-to-date');
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
        if(options.errorLevel >= 2) {
            throw new Error('Dependencies not up-to-date');
        }
    }
    print('');
}

function printLocalUpgrades(current, upgraded, installed, latest) {
    print('');
    var superlative = options.greatest ? "Greatest" : "Latest";
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
    if(execName === 'npm-check-updates') {
        print('You can now use the alias "bcu" for less typing!');
    }

    if (program.global && program.upgrade) {
        print("bower-check-updates cannot update global packages.");
        print("Run 'npm install -g [package]' to upgrade a global package.");
        process.exit(1);
    }

    // add shortcut for any keys that start with 'json'
    options.json = _(options)
        .keys()
        .filter(_.partial(_.startsWith, _, 'json', 0))
        .some(_.propertyOf(options));
}

function programRun() {
    programInit();
    return options.global ?  programRunGlobal() : programRunLocal();
}

function programRunGlobal() {
    return analyzeGlobalPackages();
}

function programRunLocal() {

    var pkgFile;
    var json;

    if(!process.stdin.isTTY) {
        pkgData = require('get-stdin-promise');
        pkgFile = null; // this signals analyzeProjectDependencies to search for installed dependencies and to not print the upgrade message
    }
    else {
        // find the closest descendant package
        pkgFile = closestPackage.sync(process.cwd());
        if (!fs.existsSync(pkgFile)) {
            throw new Error('bower.json not found');
        }

        // print a message if we are using a descendant bower.json
        var relPathToPackage = path.relative(process.cwd(), pkgFile);
        if(relPathToPackage !== 'bower.json') {
            print('Using ' + relPathToPackage);
        }

        pkgData = readPackageFile(pkgFile, null, false);
    }

    return pkgData.then(_.partial(analyzeProjectDependencies, _, pkgFile));
}

module.exports = _.merge({
    run: function(opts) {
        options = opts || {};
        options.args = options.args || [];

        return vm.initialize(options.global).then(programRun);
    }
}, vm);
