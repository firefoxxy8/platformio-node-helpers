/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { getCacheDir , getEnvBinDir, getEnvDir, getHomeDir } from './core';

import fs from 'fs-plus';
import path from 'path';
import qs from 'querystringify';
import request from 'request';
import spawn from 'cross-spawn';
import tmp from 'tmp';

export const IS_WINDOWS = process.platform.startsWith('win');

export function patchOSEnviron({ caller, useBuiltinPIOCore=true, extraPath, extraVars }) {
  process.env.PLATFORMIO_CALLER = caller;
  // Fix for platformio-atom-ide/issues/112
  if (process.platform === 'darwin') {
    process.env.LC_ALL = 'en_US.UTF-8';
  }
  if (caller === 'atom') {
    process.env.PLATFORMIO_DISABLE_PROGRESSBAR = 'true';
  }

  if (extraVars) {
    Object.keys(extraVars).forEach(name => process.env[name] = extraVars[name]);
  }

  // Fix for https://github.com/atom/atom/issues/11302
  if (process.env.Path) {
    if (process.env.PATH) {
      process.env.PATH += path.delimiter + process.env.Path;
    } else {
      process.env.PATH = process.env.Path;
    }
  }

  if (useBuiltinPIOCore) { // Insert bin directory into PATH
    process.env.PATH = [getEnvBinDir(), getEnvDir(), process.env.PATH].join(path.delimiter);
  } else { // Remove bin directory from PATH
    process.env.PATH = process.env.PATH.split(path.delimiter).filter(p => !p.includes(getEnvDir())).join(path.delimiter);
  }

  if (extraPath && !process.env.PATH.includes(extraPath)) {
    process.env.PATH = [extraPath, process.env.PATH].join(path.delimiter);
  }

  // copy PATH to Path (Windows issue)
  if (process.env.Path) {
    process.env.Path = process.env.PATH;
  }
}

export function runCommand(cmd, args, callback=undefined, options = {}) {
  console.info('runCommand', cmd, args, options);
  const outputLines = [];
  const errorLines = [];
  let completed = false;
  let tmpDir = null;

  if (IS_WINDOWS && ['pip', 'virtualenv'].some(item => [path.basename(cmd), ...args].includes(item))) {
    // Overwrite TMPDIR and avoid issue with ASCII error for Python's PIP
    const tmpEnv = Object.assign({}, process.env);
    tmpDir = tmp.dirSync({
      dir: getCacheDir(),
      unsafeCleanup: true
    }).name;
    tmpEnv.TMPDIR = tmpEnv.TEMP = tmpEnv.TMP = tmpDir;
    options.spawnOptions = options.spawnOptions || {};
    options.spawnOptions.env = tmpEnv;
  }

  try {
    const child = spawn(cmd, args, options.spawnOptions);

    child.stdout.on('data', (line) => outputLines.push(line));
    child.stderr.on('data', (line) => errorLines.push(line));
    child.on('close', onExit);
    child.on('error', (err) => {
      errorLines.push(err.toString());
      onExit(-1);
    }
    );
  } catch (err) {
    errorLines.push(err.toString());
    onExit(-1);
  }

  function onExit(code) {
    if (completed || !callback) {
      return;
    }
    completed = true;

    if (tmpDir) {
      try {
        fs.removeSync(tmpDir);
      } catch (err) {
        console.warn(err);
      }
    }

    const stdout = outputLines.map(x => x.toString()).join('');
    const stderr = errorLines.map(x => x.toString()).join('');
    callback(code, stdout, stderr);
  }
}

export function processHTTPRequest(url, callback, options) {
  options = options || {};
  options.url = url;
  if (!options.hasOwnProperty('headers')) {
    options.headers = {
      'User-Agent': 'PlatformIO'
    };
  }
  console.info('processHTTPRequest', options);
  return request(options, (err, response, body) => {
    return callback(err, response, body);
  });
}

export async function getPythonExecutable(useBuiltinPIOCore=true, customDirs = undefined) {
  const exenames = IS_WINDOWS ? ['python.exe'] : ['python2.7', 'python2', 'python'];
  const locations = customDirs || [];

  if (useBuiltinPIOCore) {
    locations.push(getEnvBinDir());
    locations.push(getEnvDir()); // conda
  }
  if (IS_WINDOWS) {
    // sometime Python is installed to the root of C drive
    locations.push('C:\\Python27');
    // isolated Python 2.7 in PlatformIO Home directory
    locations.push(path.join(getHomeDir(), 'python27'));
  }
  // extend with paths from env.PATH
  process.env.PATH.split(path.delimiter).forEach(item => {
    if (!locations.includes(item)) {
      locations.push(item);
    }
  });

  for (const location of locations) {
    for (const exename of exenames) {
      const executable = path.normalize(path.join(location, exename)).replace(/"/g, '');
      if (fs.isFileSync(executable) && (await isPython2(executable))) {
        return executable;
      }
    }
  }
  return undefined;
}

function isPython2(executable) {
  const pythonLines = [
    'import sys',
    'assert sys.platform != "cygwin"',
    'assert not sys.platform.startswith("win") or not any(s in sys.executable.lower() for s in ("msys", "mingw"))',
    'assert sys.version_info < (3, 0, 0)'
  ];
  if (IS_WINDOWS) {
    pythonLines.push('assert sys.version_info >= (2, 7, 9)');
  } else {
    pythonLines.push('assert sys.version_info >= (2, 7, 5)');
  }
  const args = ['-c', pythonLines.join(';')];
  return new Promise(resolve => {
    runCommand(
      executable,
      args,
      code => {
        resolve(code === 0);
      }
    );
  });
}

export function getErrorReportUrl(title, description) {
  const errorToUrls = [
    ['_remove_dead_weakref', 'https://github.com/platformio/platformio-vscode-ide/issues/142'],
    ["Could not install 'tool-pioplus'", 'https://github.com/platformio/platformio-vscode-ide/issues/131'],
    ['http://bit.ly/pio-core-virtualenv', 'https://github.com/platformio/platformio-vscode-ide/issues/154'],
    ['Could not start PIO Home server: Error: timeout', 'https://github.com/platformio/platformio-vscode-ide/issues/205']
  ];
  for (const item of errorToUrls) {
    if (description.includes(item[0])) {
      return item[1];
    }
  }
  return `https://github.com/platformio/platformio-vscode-ide/issues/new?${qs.stringify(
    { title: encodeURIComponent(title), body: encodeURIComponent(description) })}`;
}
