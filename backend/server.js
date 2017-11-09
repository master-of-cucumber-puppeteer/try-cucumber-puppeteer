'use strict';

const fs = require('fs');
const express = require('express');
// const {spawn} = require('child_process');
const mime = require('mime');
const upload = require('multer')();
const vm = require('vm');
const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let EXAMPLES_CACHE = [];

async function listExamples() {
  if (EXAMPLES_CACHE.length) {
    return EXAMPLES_CACHE;
  }

  return new Promise((resolve, reject) => {
    try {
      console.log('My dir: '+ __dirname);
      const examples = fs.readdirSync('/app/purecloud-example/features')
          .filter(filename => !filename.startsWith('.') && filename.endsWith('.feature'));
      EXAMPLES_CACHE = examples;
      console.log('Examples: ' + examples)
      return resolve(examples);
    } catch (err) {
      reject(err);
    }
  });
}

listExamples(); // Populate when server fires up.

function setupFileCreationWatcher() {
  // TODO: do more than this to cleanup + prevent malicious deeds.
  return new Promise((resolve, reject) => {
    const watcher = fs.watch('./', {recursive: true}, (eventType, filename) => {
      watcher.close();
      resolve(filename);
    });
  });
}

/**
 * @param {!Promise<string>} fileCreated
 * @param {!Array<string>} log
 * @return {!Promise<!Object>}
 */
async function buildResponse(fileCreated, log) {
  const respObj = {log: log.join('\n')};
  // If a screenshot/pdf was saved, get its filename and mimetype.
  // Wait a max of 100ms for a file to be created. The race is necessary
  // because the promise may never never resolve if the user's code never
  // attempts to create a file.
  const filename = await Promise.race([fileCreated, sleep(100)]);
  if (filename) {
    respObj.result = {
      type: mime.getType(filename),
      buffer: fs.readFileSync(filename)
    };
    fs.unlinkSync(filename); // Remove the file that the user created.
  }
  return respObj;
}

/**
 * @param {string} code User code to run.
 * @return {!Promise}
 */
function runCodeInSandbox(code) {
  code = `
    const log = [];

    // Define inline functions and capture user console logs.
    const logger = (...args) => log.push(args);
    console.log = logger;
    console.info = logger;
    console.warn = logger;

    const sleep = ${sleep.toString()}; // inline function
    const fileCreated = ${setupFileCreationWatcher.toString()}(); // inline function

    // Wrap user code in an async function so async/await can be used out of the box.
    (async() => {
      ${code} // user's code
      // Close the chrome even if user doesn't. This assumes they've used a var
      // called "browser".
      if (typeof browser !== 'undefined') {
        await browser.close();
      }
      return ${buildResponse.toString()}(fileCreated, log); // inline function, call it
    })();
  `;

  const fsFunc = (func, ...args) => {
    const filename = args[0];
    // Restrict file reads to images, pdfs.
    if (/^(\w|\.\/)+\.(png|jpg|jpeg|pdf)$/m.test(filename)) {
      return func(...args);
    }
    throw Error(`ENOENT: no such file or directory, open '${filename}'`);
  };

  // Sandbox user code. Provide new context with limited scope.
  const scope = {
    mime,
    setTimeout,
    puppeteer,
    fs: {
      watch: fs.watch,
      readFileSync: (...args) => fsFunc(fs.readFileSync, ...args),
      unlinkSync: (...args) => fsFunc(fs.unlinkSync, ...args)
    }
  };

  return vm.runInNewContext(code, scope);
}

// /**
//  * @param {string} code User code to run.
//  * @return {!Promise}
//  */
// function runCodeUsingSpawn(code) {
//   return new Promise((resolve, reject) => {
//     const createdFile = setupFileCreationWatcher();

//     // Wrap user code in an async function so async/await can be used out of the box.
//     code = `(async() => {
//       ${code}
//     })();`;

//     const log = [];
//     const cmd = spawn('node', ['-e', code]);
//     cmd.stdout.on('data', data => log.push(data));
//     cmd.stderr.on('data', data => log.push(data));

//     cmd.on('close', processCode => {
//       resolve(buildResponse(createdFile, log));
//     });
//   });
// }

const app = express();
app.use(function cors(req, res, next) {
  const dev = req.hostname.includes('localhost');
  const origin = dev ? 'http://localhost:8081': 'https://try-puppeteer.appspot.com';
  res.header('Access-Control-Allow-Origin', origin);
  // res.header('Content-Type', 'application/json;charset=utf-8');
  // res.header('Cache-Control', 'private, max-age=300');
  next();
});
app.use(express.static('/app/purecloud-example/features'));

app.get('/', (req, res, next) => {
  res.status(200).send('It works!');
});

app.get('/examples', async (req, res, next) => {
  res.status(200).json(await listExamples());
});

app.post('/run', upload.single('file'), async (req, res, next) => {
  const code = req.file.buffer.toString();

  // TODO: limit # listeners that can be added. Crashes keep adding more.
  process.on('unhandledRejection', err => {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).send({errors: `Error running your code. ${err}`});
    }
  });

  try {
    const result = await runCodeInSandbox(code); // await runCodeUsingSpawn(code);
    if (!res.headersSent) {
      res.status(200).send(result);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).send({errors: `Error running your code. ${err}`});
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});
