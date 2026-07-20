// Metro config with monorepo wiring. @gymtrack/core is linked into node_modules
// via a `file:../core` dependency, so normal resolution finds it; watching the
// core folder makes edits hot-reload and lets Metro transpile its source.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '..', 'core');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [coreRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;
