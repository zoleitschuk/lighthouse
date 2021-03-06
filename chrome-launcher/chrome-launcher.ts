/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as chromeFinder from './chrome-finder';
import {getRandomPort} from './random-port';
import {DEFAULT_FLAGS} from './flags';
import {makeTmpDir, defaults, delay} from './utils';
import * as net from 'net';
const rimraf = require('rimraf');
const log = require('../lighthouse-core/lib/log');
const spawn = childProcess.spawn;
const execSync = childProcess.execSync;
const isWindows = process.platform === 'win32';
const _SIGINT = 'SIGINT';
const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

type SupportedPlatforms = 'darwin'|'linux'|'win32';

export interface Options {
  startingUrl?: string;
  chromeFlags?: Array<string>;
  port?: number;
  handleSIGINT?: boolean;
  chromePath?: string;
}

export interface LaunchedChrome {
  pid: number;
  port: number;
  kill: () => Promise<{}>;
}

export async function launch(opts: Options = {}): Promise<LaunchedChrome> {
  opts.handleSIGINT = defaults(opts.handleSIGINT, true);

  const instance = new Launcher(opts);

  // Kill spawned Chrome process in case of ctrl-C.
  if (opts.handleSIGINT) {
    process.on(_SIGINT, async () => {
      await instance.kill();
      process.exit(_SIGINT_EXIT_CODE);
    });
  }

  await instance.launch();

  return {pid: instance.pid!, port: instance.port!, kill: async () => instance.kill()};
}

export class Launcher {
  private tmpDirandPidFileReady = false;
  private pollInterval: number = 500;
  private pidFile: string;
  private startingUrl: string;
  private TMP_PROFILE_DIR: string;
  private outFile?: number;
  private errFile?: number;
  private chromePath?: string;
  private chromeFlags: string[];
  private chrome?: childProcess.ChildProcess;
  private requestedPort?: number;
  port?: number;
  pid?: number;

  constructor(opts: Options = {}) {
    // choose the first one (default)
    this.startingUrl = defaults(opts.startingUrl, 'about:blank');
    this.chromeFlags = defaults(opts.chromeFlags, []);
    this.requestedPort = defaults(opts.port, 0);
    this.chromePath = opts.chromePath;
  }

  private get flags() {
    const flags = DEFAULT_FLAGS.concat([
      `--remote-debugging-port=${this.port}`,
      // Place Chrome profile in a custom location we'll rm -rf later
      `--user-data-dir=${this.TMP_PROFILE_DIR}`
    ]);

    if (process.platform === 'linux') {
      flags.push('--disable-setuid-sandbox');
    }

    flags.push(...this.chromeFlags);
    flags.push(this.startingUrl);

    return flags;
  }

  private prepare() {
    const platform = process.platform as SupportedPlatforms;
    if (!_SUPPORTED_PLATFORMS.has(platform)) {
      throw new Error(`Platform ${platform} is not supported`);
    }

    this.TMP_PROFILE_DIR = makeTmpDir();

    this.outFile = fs.openSync(`${this.TMP_PROFILE_DIR}/chrome-out.log`, 'a');
    this.errFile = fs.openSync(`${this.TMP_PROFILE_DIR}/chrome-err.log`, 'a');

    // fix for Node4
    // you can't pass a fd to fs.writeFileSync
    this.pidFile = `${this.TMP_PROFILE_DIR}/chrome.pid`;

    log.verbose('ChromeLauncher', `created ${this.TMP_PROFILE_DIR}`);

    this.tmpDirandPidFileReady = true;
  }

  async launch() {
    if (this.requestedPort !== 0) {
      this.port = this.requestedPort;

      // If an explict port is passed first look for an open connection...
      try {
        return await this.isDebuggerReady();
      } catch (err) {
        log.log(
            'ChromeLauncher',
            `No debugging port found on port ${this.port}, launching a new Chrome.`);
      }
    }

    if (!this.tmpDirandPidFileReady) {
      this.prepare();
    }

    if (this.chromePath === undefined) {
      const installations = await chromeFinder[process.platform as SupportedPlatforms]();
      if (installations.length === 0) {
        throw new Error('No Chrome Installations Found');
      }

      this.chromePath = installations[0];
    }

    this.pid = await this.spawn(this.chromePath);
    return Promise.resolve();
  }

  private async spawn(execPath: string) {
    // Typescript is losing track of the return type without the explict typing.
    const spawnPromise: Promise<number> = new Promise(async (resolve) => {
      if (this.chrome) {
        log.log('ChromeLauncher', `Chrome already running with pid ${this.chrome.pid}.`);
        return resolve(this.chrome.pid);
      }


      // If a zero value port is set, it means the launcher
      // is responsible for generating the port number.
      // We do this here so that we can know the port before
      // we pass it into chrome.
      if (this.requestedPort === 0) {
        this.port = await getRandomPort();
      }

      const chrome = spawn(
          execPath, this.flags, {detached: true, stdio: ['ignore', this.outFile, this.errFile]});
      this.chrome = chrome;

      fs.writeFileSync(this.pidFile, chrome.pid.toString());

      log.verbose('ChromeLauncher', `Chrome running with pid ${chrome.pid} on port ${this.port}.`);
      resolve(chrome.pid);
    });

    const pid = await spawnPromise;
    await this.waitUntilReady();
    return pid;
  }

  private cleanup(client?: net.Socket) {
    if (client) {
      client.removeAllListeners();
      client.end();
      client.destroy();
      client.unref();
    }
  }

  // resolves if ready, rejects otherwise
  private isDebuggerReady(): Promise<{}> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.port!);
      client.once('error', err => {
        this.cleanup(client);
        reject(err);
      });
      client.once('connect', () => {
        this.cleanup(client);
        resolve();
      });
    });
  }

  // resolves when debugger is ready, rejects after 10 polls
  private waitUntilReady() {
    const launcher = this;

    return new Promise((resolve, reject) => {
      let retries = 0;
      let waitStatus = 'Waiting for browser.';
      (function poll() {
        if (retries === 0) {
          log.log('ChromeLauncher', waitStatus);
        }
        retries++;
        waitStatus += '..';
        log.log('ChromeLauncher', waitStatus);

        launcher.isDebuggerReady()
            .then(() => {
              log.log('ChromeLauncher', waitStatus + `${log.greenify(log.tick)}`);
              resolve();
            })
            .catch(err => {
              if (retries > 10) {
                return reject(err);
              }
              delay(launcher.pollInterval).then(poll);
            });
      })();
    });
  }

  kill() {
    return new Promise(resolve => {
      if (this.chrome) {
        this.chrome.on('close', () => {
          this.destroyTmp().then(resolve);
        });

        log.log('ChromeLauncher', 'Killing all Chrome Instances');
        try {
          if (isWindows) {
            execSync(`taskkill /pid ${this.chrome.pid} /T /F`);
          } else {
            process.kill(-this.chrome.pid);
          }
        } catch (err) {
          log.warn('ChromeLauncher', `Chrome could not be killed ${err.message}`);
        }

        delete this.chrome;
      } else {
        // fail silently as we did not start chrome
        resolve();
      }
    });
  }

  private destroyTmp() {
    return new Promise(resolve => {
      if (!this.TMP_PROFILE_DIR) {
        return resolve();
      }

      log.verbose('ChromeLauncher', `Removing ${this.TMP_PROFILE_DIR}`);

      if (this.outFile) {
        fs.closeSync(this.outFile);
        delete this.outFile;
      }

      if (this.errFile) {
        fs.closeSync(this.errFile);
        delete this.errFile;
      }

      rimraf(this.TMP_PROFILE_DIR, () => resolve());
    });
  }
};
