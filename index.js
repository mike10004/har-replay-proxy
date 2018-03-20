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

const _fs = require("fs");
const http = require("http");
const URL = require("url");
const PATH = require("path");
const mime = require("mime");
const heuristic = require("./heuristic");
const _NOOP = function() {};
const parseContentType = require("content-type-parser");
const crypto = require('crypto');
module.exports = {};

(function(){
    
    function serverReplay(har, options, callback) {
        var server = http.createServer(makeRequestListener(har.log.entries, options));
        server.listen(options.port, callback || _NOOP);
    }
    
    function makeRequestListener(entries, options) {
        var config = options.config;
        var resolvePath = options.resolvePath;
        var debug = options.debug;
        // for mocking
        var fs = options.fs || _fs;
    
        return function (request, response) {
            request.parsedUrl = URL.parse(request.url, true);
    
            var entry = heuristic(entries, request);
    
            var localPath;
            for (var i = 0; i < config.mappings.length; i++) {
                if ((localPath = config.mappings[i](request.url))) {
                    localPath = PATH.resolve(resolvePath, localPath);
                    break;
                }
            }
    
            if (localPath) {
                // If there's local content, but no entry in the HAR, create a shim
                // entry so that we can still serve the file
                if (!entry) {
                    const mimeType = mime.getType(localPath);
                    entry = {
                        response: {
                            status: 200,
                            headers: [{
                                name: 'Content-Type',
                                value: mimeType
                            }],
                            content: {
                                mimeType: mimeType
                            }
                        }
                    };
                }
    
                // If we have a file location, then try and read it. If that fails, then
                // return a 404
                fs.readFile(localPath, function (err, content) {
                    if (err) {
                        console.error("Error: Could not read", localPath, "requested from", request.url);
                        serveError(options, request, response, null, localPath);
                        return;
                    }
    
                    entry.response.content.buffer = content;
                    serveEntry(options, request, response, entry, config);
                });
            } else {
                if (!serveError(options, request, response, entry && entry.response)) {
                    serveEntry(options, request, response, entry, config);
                }
            }
    
        };
    }

    function makeHashProvider(content) {
        if (typeof content === 'undefined') {
            return () => '';
        } else {
            return () => crypto.createHash('md5').update(content).digest('hex');
        }
    }

    function ResponseSummary(status, contentType, origin, content) {
        this.status = status;
        this.contentType = contentType;
        this.contentLength = content.length;
        this.origin = origin;
        this.hashProvider = makeHashProvider(content);
    }
    
    function logInteraction(options, request, response) {
        if (options.debug) {
            const hash = response.hashProvider();
            console.log(response.status, request.method, request.url, response.contentType, response.contentLength, response.origin, hash);
        }
    }
    
    /**
     * Maybe serves an error response.
     * @param {object} request 
     * @param {object} response 
     * @param {object} entryResponse 
     * @param {string} localPath 
     * @returns {boolean} true if a response was served, false otherwise
     */
    function serveError(options, request, response, entryResponse, localPath) {
        const requestUrl = request.url, requestMethod = request.method;
        if (!entryResponse) {
            const contentType = "text/plain; charset=UTF-8"; // just ascii text
            response.writeHead(404, "Not found", {"content-type": contentType});
            const content = "404 Not found";
            response.end(content);
            logInteraction(options, request, new ResponseSummary(404, contentType, 'noentrymatch', content));
            return true;
        }
    
        // A resource can be blocked by the client recording the HAR file. Chrome
        // adds an `_error` string property to the response object. Also try
        // detecting missing status for other generators.
        if (entryResponse._error || !entryResponse.status) {
            var error = entryResponse._error ? JSON.stringify(entryResponse._error) : "Missing status";
            const contentType = "text/plain; charset=UTF-8";
            response.writeHead(410, error, {"content-type": contentType});
            const message = "HAR response error: " + error +
                "\n\nThis resource might have been blocked by the client recording the HAR file. For example, by the AdBlock or Ghostery extensions.";
            const content = Buffer.from(message, 'utf8');
            response.end(content);
            logInteraction(options, request, new ResponseSummary(410, contentType, 'clientblocked', content));
            return true;
        }
    
        return false;
    }
    
    function serveHeaders(response, entryResponse, contentType, config) {
        const status = (entryResponse.status === 304) ? 200 : entryResponse.status;
        // Not really a header, but...
        response.statusCode = status;
        for (var h = 0; h < entryResponse.headers.length; h++) {
            var name = entryResponse.headers[h].name;
            var value = entryResponse.headers[h].value;
            if (name.toLowerCase() === 'content-type') {
                value = contentType;
            }
            var nameValuePair = {'name': name, 'value': value};
            config.responseHeaderTransforms.forEach(function(transform){
                nameValuePair = transform(nameValuePair);
            })
            name = nameValuePair.name;
            value = nameValuePair.value;
    
            if (name.toLowerCase() === "content-length") continue;
            if (name.toLowerCase() === "content-encoding") continue;
            if (name.toLowerCase() === "cache-control") continue;
            if (name.toLowerCase() === "pragma") continue;
    
            var existing = response.getHeader(name);
            if (existing) {
                if (Array.isArray(existing)) {
                    response.setHeader(name, existing.concat(value));
                } else {
                    response.setHeader(name, [existing, value]);
                }
            } else {
                response.setHeader(name, value);
            }
        }
    
        // Try to make sure nothing is cached
        response.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        response.setHeader("pragma", "no-cache");
        return status;
    }
    
    function TypedContent(buffer, mimeType) {
        
        this.getBuffer = function() {
            return buffer || Buffer.from('', 'utf8');
        }

        this.getContentType = function() {
            return (mimeType || 'application/octet-stream').toString();
        }
    }

    function extractContentType(harEntry) {
        let mimeType;
        if (harEntry && harEntry.response && harEntry.response.content) {
            mimeType = harEntry.response.content.mimeType;
        }
        return parseContentType(mimeType || 'application/octet-stream');
    }

    /**
     * 
     * @param {object} request request being answered
     * @param {object} entry HAR entry
     * @param {Array} replacements array of replacement functions
     * @returns {TypedContent} content object providing access to bytes and mime type
     */
    function manipulateContent(request, entry, replacements) {
        var entryResponse = entry.response;
        let content;
        let contentType = extractContentType(entry);
        if (isBinary(contentType)) {
            content = entryResponse.content.buffer;
        } else {
            content = entryResponse.content.buffer.toString('utf8');
            var context = {
                request: request,
                entry: entry
            };
            replacements.forEach(replacement => {
                content = replacement(content, context);
            });
            if (typeof content === 'string') {
                contentType.set('charset', contentType.get('charset') || 'utf8');
                content = Buffer.from(content, contentType.get('charset'));
            }
        }
    
        if (entryResponse.content.size > 0 && !content) {
            console.error("Error:", entry.request.url, "has a non-zero size, but there is no content in the HAR file");
        }
    
        return new TypedContent(content, contentType.toString());
    }
    
    function isBase64Encoded(entryResponse) {
        if (!entryResponse.content.text) {
            return false;
        }
        var base64Size = entryResponse.content.size / 0.75;
        var contentSize = entryResponse.content.text.length;
        return contentSize && contentSize >= base64Size && contentSize <= base64Size + 4;
    }
    
    function isBinary(ct) {
        if (ct && ct.isText() || ct.isXML() || ct.subtype === 'json') {
            return false;
        }
        return true;
    }
    
    function serveEntry(options, request, response, entry, config) {
        const entryResponse = entry.response;
    
        if (!entryResponse.content.buffer) {
            if (isBase64Encoded(entryResponse)) {
                entryResponse.content.buffer = Buffer.from(entryResponse.content.text || "", 'base64');
            } else {
                entryResponse.content.buffer = Buffer.from(entryResponse.content.text || "", 'utf8');
            }
        }
        const typedContent = manipulateContent(request, entry, config.replacements);
        const status = serveHeaders(response, entryResponse, typedContent.getContentType(), config);
        const content = typedContent.getBuffer();
        response.end(content);
        const responseSummary = new ResponseSummary(status, typedContent.getContentType(), 'matchedentry', content);
        logInteraction(options, request, responseSummary);
    }

    module.exports.serverReplay = serverReplay;
    module.exports.makeRequestListener = makeRequestListener;
})();
