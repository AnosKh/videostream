#!/usr/bin/env node

// Required dependencies
const inherits = require('inherits');
const pkg = require('../package.json');
const UglifyJS = require("uglify-js");
const Browserify = require('browserify');
const Transform = require('stream').Transform || require('readable-stream').Transform;

// Helper constants
const cwd = String(process.cwd()).replace(/\\/g, '/');
const startTime = Date.now();
let files = 0, sizes = 0;

// Starts bundle creation
function makeBundle() {
    const b = new Browserify('./bundle/main.js');

    // Apply our transform.
    b.transform({global: true}, Megaify);

    // Build the bundle.
    b.bundle(function(err, buf) {
        if (err) {
            process.stderr.write(err.message + '\n');
            process.exit(1);
        }
        else {
            const user = process.env.username;
            const date = new Date().toISOString().replace(/-/g, '/').replace('T', ' ').split('.')[0];
            const header =
                '/**\n' +
                ' * This file is automatically generated. Do not edit it.\n' +
                ' * $Id: videostream.js,v ' + pkg.version + ' ' + date + ' ' + user + ' Exp $\n' +
                ' */\n';

            buf = buf.toString('utf-8');

            // Perform final transforms over the final bundle
            buf = buf.replace(new RegExp(cwd.replace(/\W/g, '\\$&'), 'g'), '');

            buf = header + buf;
            process.stdout.write(buf);

            process.stderr.write(
                '\n' +
                'Bundle created with size ' + buf.length + ' bytes,' +
                ' from ' + files + ' files with a sum of ' + sizes + ' bytes.\n' +
                'Process took: ' + (Date.now() - startTime) + 'ms\n'
            );

            process.exit(0);
        }
    });
}

// Our transform, thanks http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
function Megaify(filename) {
    if (!(this instanceof Megaify)) {
        return new Megaify(filename);
    }
    Transform.call(this);

    this.cwd = cwd;
    this.filesize = require('fs').statSync(filename).size;
    this.filename = String(filename).replace(/\\/g, '/').replace(this.cwd, '..');

    process.stderr.write('Bundling "' + this.filename + '" (' + this.filesize + ' bytes)\n');

    files++;
    sizes += this.filesize;
}

inherits(Megaify, Transform);

Megaify.prototype._transform = function(chunk, enc, cb) {
    const self = this;

    chunk = chunk.toString('utf-8');

    // Export mp4-box-encoding's boxes so we can extend them externally
    if (this.filename.indexOf('/mp4-box-encoding/index.js') > 0) {
        chunk = chunk.replace('Box = exports', 'Box=exports;Box.boxes=boxes');

        // Provide a more meaningful message for unsupported videos
        chunk = chunk.replace("'Data too short'", "'Unsupported media format, data too short...'");
    }

    // Replace the slow .slice(arguments) usage
    if (this.filename.indexOf('/pump/index.js') > 0) {
        chunk = chunk.replace('var streams = Array.prototype.slice.call(arguments)',
            'var i = arguments.length;' +
            'var streams = new Array(i);' +
            'while(i--) streams[i] = arguments[i];');

        // we don't need fs
        chunk = chunk.replace("var fs = require('fs')", '');
        chunk = chunk.replace('var isFS = function', 'if(0)$&');
        chunk = chunk.replace('isFS(stream)', '0');
    }

    // readable-stream includes core-util-is, but it's unused in the browser, dead code elimination
    // won't remove it because the inherits module is then defined extending core-util-is...
    if (this.filename.indexOf('readable-stream') > 0) {
        chunk = chunk.replace("var util = require('core-util-is');", '');
        chunk = chunk.replace('util.inherits =', 'var inherits =');
        chunk = chunk.replace('util.inherits(', 'inherits(');
        // ^ yes, it's used/invoked once per file only

        // Replace the isarray module, we don't need a fallback for older browsers
        chunk = chunk.replace("require('isarray')", 'Array.isArray');

        // We don't need any process.* stuff...
        const re = new RegExp("require('process-nextick-args')".replace(/\W/g, '\\$&'), 'g');
        chunk = chunk.replace(re, self.getUtilsMod(1) + '.nextTick');
        chunk = chunk.replace(' && dest !== process.stdout && dest !== process.stderr', '');

        chunk = this.getReplacements(chunk, function(match) {

            // Let's use our MegaLogger
            if (match.indexOf('debugUtil') > 0) {
                return 'var debug = ' + self.getUtilsMod(1) + '.debuglog("stream")';
            }

            // Let's use our nextTick based on requestIdleCallback
            if (match.indexOf('var asyncWrite =') > 0) {
                return 'var asyncWrite = ' + self.getUtilsMod(1) + '.nextTick';
            }

            // Let's use our tiny deprecate shim
            if (match.indexOf('internalUtil') > 0) {
                return 'var deprecate = ' + self.getUtilsMod(1) + '.deprecate';
            }

            // OurUint8Array is just Uint8Array in the browser
            if (match.indexOf('OurUint8Array') > 0) {
                return 'var _isUint8Array=' + self.getUtilsMod(1) + '.isU8,Buffer=require("buffer").Buffer';
            }

            return match;
        });

        // Remove util-deprecate dependency
        chunk = chunk.replace('internalUtil.deprecate(', 'deprecate(');

        // Replace redundant _uint8ArrayToBuffer
        chunk = chunk.replace('_uint8ArrayToBuffer', 'Buffer.from');
    }

    // Replace references to process.* and explicitly include Buffer to prevent a closure
    if (this.filename.indexOf('mp4-stream/encode.js') > 0) {
        chunk = chunk.replace('return process.nextTick', 'return nextTick');
        chunk = chunk.replace('function noop () {}',
            'var nextTick=' + self.getUtilsMod(1) + '.nextTick, Buffer = require("buffer").Buffer;\n$&');
    }

    // Fix off-by-one bug in uint64be v1.0.1
    if (this.filename.indexOf('/uint64be/index.js') > 0) {
        chunk = chunk.replace('UINT_32_MAX = 0xffffffff', 'UINT_32_MAX = Math.pow(2, 32)');
    }

    // safe-buffer seems redundant for the browser...
    chunk = chunk.replace("require('safe-buffer').Buffer", "require('buffer').Buffer");

    // No fallback needed for Object.create
    chunk = chunk.replace("require('inherits')", self.getUtilsMod(1) + '.inherit');

    // Let's remove dead code and such...
    const uglify = UglifyJS.minify(chunk, {
        warnings: true,
        mangle: {
            keep_fnames: true
        },
        compress: {
            passes: 2,
            sequences: false,
            pure_getters: true,
            keep_infinity: true
        },
        output: {
            beautify: true,
            indent_level: 2,
            ascii_only: true,
            comments: 'some'
        }
    });

    if (uglify) {
        if (uglify.error) {
            process.stderr.write('UglifyJS error: ' + uglify.error + '\n');
        }
        else {
            chunk = uglify.code;

            if (uglify.warnings) {
                const tag = 'UglifyJS(' + this.filename + '): ';
                process.stderr.write(tag + uglify.warnings.join("\n" + tag) + '\n');
            }
        }
    }

    this.push(chunk);
    cb();
};

Megaify.prototype.getReplacements = function(chunk, filter) {
    return chunk.replace(/\/\*<replacement>\*\/[\s\S]*?\/\*<\/replacement>\*\//g, filter);
};

Megaify.prototype.getUtilsMod = function(asreq) {
    const module = this.cwd + '/bundle/utils';

    return asreq ? 'require("' + module + '")' : module;
};

makeBundle();
