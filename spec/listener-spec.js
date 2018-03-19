/*
 * Copyright (c) 2015 Adobe Systems Incorporated. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const HRP = require('../index');
const makeRequestListener = HRP.makeRequestListener;
const assert = require('assert');

function MockRequest(method, url) {
    this.method = method;
    this.url = url;
    const headers = {};

    this.setHeader = function(name, value) {
        headers[name] = value;
    };
}

function MockResponse() {

    const headers = {};
    const buffer = Buffer.alloc(1024, 0, 'utf8');
    const headerBuffer = Buffer.alloc(1024, 0, 'utf8');
    let ended = false;
    const self = this;

    this.setHeader = function(name, value) {
        headers[name] = value;
    };

    function doWrite(content, encoding, callback, internalCallback) {
        assert(typeof content !== 'undefined');
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = 'utf8';
        }
        if (typeof callback === 'undefined') {
            callback = () => {};
        }
        buffer.write(content);
        internalCallback();
        callback();
    };

    this.write = function(content, encoding, callback) {
        doWrite(content, encoding, callback, () => {});
    };

    this.end = function(content, encoding, callback) {
        doWrite(content, encoding, callback, () => {
            ended = true;
        });
    };

    this.writeHead = function(statuscode, statusMessage, headers) {
        self.statusCode = statuscode;
        self.statusMessage = statusMessage;
        for (let name in headers) {
            self.setHeader(name, headers[name]);
        };
    };

    this.mock = {
        getContentAsString: function(encoding) {
            return buffer.toString(encoding);
        }
    };

    this.getHeader = function(name) {
        return headers[name];
    };
}

describe("makeRequestListener", function () {
    it("resolves paths relative to the resolvePath", function () {
        var readFile = jasmine.createSpy();
        var listener = makeRequestListener([], {
            config: {
                mappings: [function () { return "./dir/name.js"; }],
                replacements: [],
                responseHeaderTransforms: [],
            },
            resolvePath: "/root",
            fs: {
                readFile: readFile
            }
        });
        var response = new MockResponse();
        listener(new MockRequest("GET", "http://foo.bar/"), response);
        expect(readFile).toHaveBeenCalled();
        expect(readFile.mostRecentCall.args[0]).toEqual("/root/dir/name.js");
    });
});

describe('makeRequestListener', () => {
    it('serves matching entry from HAR', () => {
        const har = JSON.parse(require('fs').readFileSync('./spec/http.www.example.com.har'));
        const entries = har.log.entries;
        const options = {
            config: {
                mappings: [],
                replacements: [],
                responseHeaderTransforms: [],
            }
        };
        const requestListener = makeRequestListener(entries, options);
        const request = new MockRequest("GET", entries[0].request.url);
        const response = new MockResponse();
        requestListener(request, response);
        expect(response.statusCode).toEqual(200);
        const responseStr = response.mock.getContentAsString();
        expect(responseStr.indexOf('ABCDEFG Domain') >= 0).toEqual(true);
    })
});
