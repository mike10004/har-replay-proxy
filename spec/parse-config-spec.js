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

var parseConfig = require("../parse-config");

describe("readme", function () {
    var config;
    function regex(str) {
        return {
            "regex": str
        };
    }
    beforeEach(function () {
        config = parseConfig(JSON.stringify({
            "version": 1,
            "mappings": [
                {
                    "match": {"regex": ".*\\/static\\/(.*)"},
                    "path": "./public/$1"
                }
            ],
            "responseHeaderTransforms": [
                {
                    "nameMatch": "foo",
                    "valueImage": "cap"
                },
                {
                    "nameMatch": "bar",
                    "nameImage": "wut"
                },
                {
                    "nameMatch": regex("(foo\\d+)"),
                    "nameImage": "foo_numbered"
                },
                {
                    "nameMatch": regex("baz(\\d+)"),
                    "nameImage": "gaw$1"
                },
                {
                    "nameMatch": regex("([Ll]ocation)"),
                    "valueMatch": regex("^https://(.*)"),
                    "valueImage": "http://$1"
                }
            ],
            "replacements": [
                // For JSONP requests where callback name is randomly generated
                {
                    "match": {"var": "entry.request.parsedUrl.query.callback"},
                    "replace": {"var": "request.parsedUrl.query.callback"}
                },
                // Proxy only works over http
                {"match": "https", "replace": "http"}
            ]
        }));
    });

    describe("mappings", function () {
        it("matches mappings correctly", function () {
            expect(config.mappings.length).toEqual(1);
            expect(typeof config.mappings[0]).toEqual("function");
            expect(config.mappings[0]("http://example.com/one/two")).toEqual(undefined);
            expect(config.mappings[0]("http://example.com/static/one/two")).toEqual("./public/one/two");
            expect(config.mappings[0]("http://example.com/something/static/one/two")).toEqual("./public/one/two");
        });
    });

    describe("replacements", function () {
        it("finds and replaces variables", function () {
            expect(config.replacements.length).toEqual(2);
            expect(typeof config.replacements[0]).toEqual("function");
            expect(config.replacements[0]("a\nfail\nb\n   fail\nc\n", {
                entry: {request: {parsedUrl: {query: {callback: "fail"}}}},
                request: {parsedUrl: {query: {callback: "pass"}}}
            })).toEqual("a\npass\nb\n   pass\nc\n");
        });

        it("finds and replaces all strings", function () {
            expect(config.replacements[1]("a\nhttps\nb\n   https\nc\n", {})).toEqual("a\nhttp\nb\n   http\nc\n");
        });
    });

    describe("responseHeaderTransforms", function(){
        it("parses stuff correctly", function(){
            function headerize(name, value) {
                return {
                    'name': name,
                    'value': value
                };
            }
            
            function doAllTransforms(header) {
                config.responseHeaderTransforms.forEach(function(transform){
                    header = transform(header);
                });
                return header;
            }

            function examine(header, expected) {
                var actual = doAllTransforms(header);
                expect(actual).toEqual(expected);
            }

            expect(config.responseHeaderTransforms.length).toEqual(5);
            for (var i = 0; i < config.responseHeaderTransforms.length; i++) {
                var t = config.responseHeaderTransforms[i];
                expect(typeof(t)).toEqual('function');
            }
            examine(headerize("bean", "123"), headerize("bean", "123"));
            examine(headerize("foo", "000"), headerize("foo", "cap"));
            examine(headerize("bar", "gaw"), headerize("wut", "gaw"));
            examine(headerize("foo3", "jkl"), headerize("foo_numbered", "jkl"));
            examine(headerize("baz8", "qwer"), headerize("gaw8", "qwer"));
            examine(headerize("Location", "http://foo.com/"), headerize("Location", "http://foo.com/"));
            examine(headerize("Location", "https://foo.com/"), headerize("Location", "http://foo.com/"));
        });
    })
});

it(("parses a config file without all properties"), function () {
    var config = parseConfig('{"version": 1}');
    expect(config.mappings).toEqual([]);
    expect(config.replacements).toEqual([]);
});
