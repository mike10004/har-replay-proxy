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

var _fs = require("fs");
var http = require("http");
var URL = require("url");
var PATH = require("path");
var mime = require("mime");
var heuristic = require("./heuristic");
var _NOOP = function() {};

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
                    var mimeType = mime.lookup(localPath);
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
    
    function ResponseSummary(status, contentType, contentLength, lengthType, origin) {
        this.status = status;
        this.contentType = contentType;
        this.contentLength = contentLength;
        this.lengthType = lengthType;
        this.origin = origin;
    }
    
    function logInteraction(options, request, response) {
        if (options.debug) {
            console.log(response.status, request.method, request.url, response.contentType, response.contentLength, response.lengthType, response.origin);
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
            console.log("Not found:", requestUrl);
            const contentType = "text/plain";
            response.writeHead(404, "Not found", {"content-type": contentType});
            const content = "404 Not found" + (localPath ? ", while looking for " + localPath : "");
            response.end(content);
            logInteraction(options, request, new ResponseSummary(404, contentType, content.length, 'string', 'noentrymatch'))
            return true;
        }
    
        // A resource can be blocked by the client recording the HAR file. Chrome
        // adds an `_error` string property to the response object. Also try
        // detecting missing status for other generators.
        if (entryResponse._error || !entryResponse.status) {
            var error = entryResponse._error ? JSON.stringify(entryResponse._error) : "Missing status";
            const contentType = "text/plain";
            response.writeHead(410, error, {"content-type": contentType});
            const content = "HAR response error: " + error +
                    "\n\nThis resource might have been blocked by the client recording the HAR file. For example, by the AdBlock or Ghostery extensions.";
            response.end(content);
            logInteraction(options, request, new ResponseSummary(410, contentType, content.length, 'string', 'clientblocked'));
            return true;
        }
    
        return false;
    }
    
    function serveHeaders(response, entryResponse, config) {
        const status = (entryResponse.status === 304) ? 200 : entryResponse.status;
        // Not really a header, but...
        response.statusCode = status;
        let contentType = null;
        for (var h = 0; h < entryResponse.headers.length; h++) {
            var name = entryResponse.headers[h].name;
            var value = entryResponse.headers[h].value;
    
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
            if (name.toLowerCase() === 'content-type') {
                contentType = value;
            }
        }
    
        // Try to make sure nothing is cached
        response.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        response.setHeader("pragma", "no-cache");
        return new ResponseSummary(status, contentType);
    }
    
    function manipulateContent(request, entry, replacements) {
        var entryResponse = entry.response;
        var content;
        if (isBinary(entryResponse)) {
            content = entryResponse.content.buffer;
        } else {
            content = entryResponse.content.buffer.toString("utf8");
            var context = {
                request: request,
                entry: entry
            };
            replacements.forEach(function (replacement) {
                content = replacement(content, context);
            });
        }
    
        if (entryResponse.content.size > 0 && !content) {
            console.error("Error:", entry.request.url, "has a non-zero size, but there is no content in the HAR file");
        }
    
        return content;
    }
    
    function isBase64Encoded(entryResponse) {
        if (!entryResponse.content.text) {
            return false;
        }
        var base64Size = entryResponse.content.size / 0.75;
        var contentSize = entryResponse.content.text.length;
        return contentSize && contentSize >= base64Size && contentSize <= base64Size + 4;
    }
    
    // FIXME
    function isBinary(entryResponse) {
        return /^image\/|application\/octet-stream/.test(entryResponse.content.mimeType);
    }
    
    function serveEntry(options, request, response, entry, config) {
        const entryResponse = entry.response;
        const responseSummary = serveHeaders(response, entryResponse, config);
    
        if (!entryResponse.content.buffer) {
            if (isBase64Encoded(entryResponse)) {
                entryResponse.content.buffer = new Buffer(entryResponse.content.text || "", 'base64');
            } else {
                entryResponse.content.buffer = new Buffer(entryResponse.content.text || "", 'utf8');
            }
        }
        const content = manipulateContent(request, entry, config.replacements);
        response.end(content);
        responseSummary.contentLength = content.length;
        responseSummary.lengthType = typeof content;
        responseSummary.origin = 'matchedentry';
        logInteraction(options, request, responseSummary);
    }

    module.exports.serverReplay = serverReplay;
    module.exports.makeRequestListener = makeRequestListener;
})();
