var sys = require('sys'),
	   http = require('http'),
	   https = require('https'),
	   url = require('url'),
	   qs = require('querystring'),
	   multipart = require('./multipartform'),
	   Buffer = require('buffer').Buffer,
	   Iconv  = require('iconv').Iconv;

function mixin(target, source) {
	Object.keys(source).forEach(function(key) {
		target[key] = source[key];
	});

	return target;
}

function Request(uri, options) {
	this.url = url.parse(uri);
	this.options = options;
	this.headers = {
		'Accept': '*/*',
		'User-Agent': 'Restler for node.js',
		'Host': this.url.host
	}

	mixin(this.headers, options.headers || {});

	// set port and method defaults
	if (!this.url.port) this.url.port = (this.url.protocol == 'https:') ? '443' : '80';
	if (!this.options.method) this.options.method = (this.options.data) ? 'POST' : 'GET';
	if (typeof this.options.followRedirects == 'undefined') this.options.followRedirects = true;

	// stringify query given in options of not given in URL
	if (this.options.query && !this.url.query) {
		if (typeof this.options.query == 'object') {
			this.url.query = qs.stringify(this.options.query);
		} else {
			this.url.query = this.options.query;
		}
	}

	this._applyBasicAuth();

	if (this.options.multipart) {
		this.headers['Content-Type'] = 'multipart/form-data; boundary=' + multipart.defaultBoundary;
	} else {
		if (typeof this.options.data == 'object') {
			this.options.data = qs.stringify(this.options.data);
			this.headers['Content-Type'] = 'application/x-www-form-urlencoded';
			this.headers['Content-Length'] = this.options.data.length;
		}
	}

	var proto = (this.url.protocol == 'https:') ? https : http;

	this.request = proto.request({
		host: this.url.hostname,
		port: this.url.port,
		path: this._fullPath(),
		method: this.options.method,
		headers: this.headers
	});

	this._makeRequest();
}

Request.prototype = new process.EventEmitter();

mixin(Request.prototype, {
	_isRedirect: function(response) {
		return ([301, 302].indexOf(response.statusCode) >= 0);
	},

	_fullPath: function() {
		var path = this.url.pathname || '/';
		if (this.url.hash) {
			path += this.url.hash;
		}
		if (this.url.query) {
			path += '?' + this.url.query;
		}
		return path;
	},

	_applyBasicAuth: function() {
		var authParts;

		if (this.url.auth) {
			authParts = this.url.auth.split(':');
			this.options.username = authParts[0];
			this.options.password = authParts[1];
		}

		if (this.options.username && this.options.password) {
			var b = new Buffer([this.options.username, this.options.password].join(':'));
			this.headers['Authorization'] = "Basic " + b.toString('base64');
		}
	},

	_responseHandler: function(response) {
		var self = this;

		if (this._isRedirect(response) && this.options.followRedirects == true) {
			try {
				var location = url.resolve(this.url, response.headers['location']);
				this.options.originalRequest = this;

				request(location, this.options);
			} catch(e) {
				self._respond('error', 'Failed to follow redirect', null, response, null);
			}
		} else {
			var body = new Buffer(0), bodyChunk;

			// TODO Handle different encodings
			//response.setEncoding('utf8');

			response.on('data', function(chunk) {
				bodyChunk = new Buffer(body.length + chunk.length) ;
				body.copy(bodyChunk, 0);
				chunk.copy(bodyChunk, body.length);
				body = bodyChunk;
			});

			response.on('end', function() {
				var charset = response.headers['content-type'].match(/charset=(.+)$/i)

				if(charset && !charset[1].match(/utf-8$/i)) {
					try {
						var parseIconv = new Iconv(charset[1], 'UTF-8//TRANSLIT//IGNORE');
						var parseBuffer = parseIconv.convert(body);
						body = parseBuffer.toString('utf8');
					} catch (e) {
						body = body.toString('utf8');
					}
				} else {
					body = body.toString('utf8');
				}
				
				if ((self.options.parser) && (response.statusCode < 400)) {
					self.options.parser.call(response, body, function(error, parsedData) {
						self._fireEvents(error, parsedData, response, body);
					});
				} else {
					self._fireEvents(null, null, response, body);
				}
			});
		}
	},

	_respond: function(type, error, data, response, body) {
		try {
			if (this.options.originalRequest) {
				this.options.originalRequest.emit(type, error, data, response, body);
			} else {
				this.emit(type, error, data, response, body);
			}
		} catch(e) {
			console.log("Error: Event type [" + type + "] has not been assigned a handler. Check for .on(\"" + type + "\", ...");
		}
	},

	_fireEvents: function(error, data, response, body) {
		if(parseInt(response.statusCode, 10) >= 400) {
			this._respond('error', "Request did not complete successfully. Query returned code " + parseInt(response.statusCode, 10), data, response, body);
		} else {
			this._respond('success', error, data, response, body);
		}

		this._respond(response.statusCode.toString().replace(/\d{2}$/, 'XX'), error, data, response, body);
		this._respond(response.statusCode.toString(), error, data, response, body);
		this._respond('complete', error, data, response, body);
	},

	_makeRequest: function() {
		var self = this;

		this.request.on('response', function(response) {
			self._responseHandler(response);
		}).on('error', function(error) {
			self._respond('error', error, null, null, null);
		});
	},

	run: function() {
		var self = this;

		if (this.options.multipart) {
			multipart.write(this.request, this.options.data, function() {
				self.request.end();
			});
		} else {
			if (this.options.data) {
				this.request.write(this.options.data.toString(), this.options.encoding || 'utf8');
			}
			this.request.end();
		}
		return this;
	}
});

/* Pre-processing of the options and setup of the minimums */
function parseOptions(options, method) {
	options = options || {};
	
	/* Explicitly set method if given */
	if(method != null) {
		options.method = method;
	}
	
	/* Setup the data return parser */
	options.parser = ((options.parser != null) && (parsers[options.parser] != null)) ? parsers[options.parser] : parsers.auto;
	
	return options;
}

function request(url, options) {
	return (new Request(url, parseOptions(options))).run();
}

function get(url, options) {
	return request(url, parseOptions(options, 'GET'));
}

function post(url, options) {
	return request(url, parseOptions(options, 'POST'));
}

function put(url, options) {
	return request(url, parseOptions(options, 'PUT'));
}

function del(url, options) {
	return request(url, parseOptions(options, 'DELETE'));
}

var parsers = {
	auto: function(data, callback) {
		var contentType = this.headers['content-type'];

		if (contentType) {
			for (var matcher in parsers.auto.matchers) {
				if (contentType.indexOf(matcher) == 0) {
					return parsers.auto.matchers[matcher].call(this, data, callback);
				}
			}
		}

		callback(data);
	},
	
	json: function(data, callback) {
		try {
			return callback(null, data && JSON.parse(data));
		} catch(error){
			callback(error, data);
		}
	}
};

parsers.auto.matchers = {
	'application/json': parsers.json
};

try {
	var yaml = require('yaml');

	parsers.yaml = function(data, callback) {
		return callback(data && yaml.eval(data));
	};

	parsers.auto.matchers['application/yaml'] = parsers.yaml;
} catch(e) {}

try {
	var xml2js = require('xml2js');

	parsers.xml = function(data, callback) {
		if (data) {
			var parser = new xml2js.Parser();
			
			parser.on('end', function(result) {
				callback(result);
			});

			parser.parseString(data);
		} else {
			callback();
		}
	};

	parsers.auto.matchers['application/xml'] = parsers.xml;
} catch(e) {}

function Service(defaults) {
	if (defaults.baseURL) {
		this.baseURL = defaults.baseURL;
		delete defaults.baseURL;
	}

	this.defaults = defaults;
}

mixin(Service.prototype, {
	request: function(path, options) {
		return request(this._url(path), this._withDefaults(options));
	},
	
	get: function(path, options) {
		return get(this._url(path), this._withDefaults(options));
	},
	
	put: function(path, options) {
		return put(this._url(path), this._withDefaults(options));
	},
	
	post: function(path, options) {
		return post(this._url(path), this._withDefaults(options));
	},
	
	del: function(path, options) {
		return del(this._url(path), this._withDefaults(options));
	},
	
	_url: function(path) {
		if (this.baseURL) {
			return url.resolve(this.baseURL, path);
		} else {
			return path;
		}
	},
	
	_withDefaults: function(options) {
		var o = mixin({}, this.defaults);
		return mixin(o, options);
	}
});

function service(constructor, defaults, methods) {
	constructor.prototype = new Service(defaults || {});
	mixin(constructor.prototype, methods);
	return constructor;
}

mixin(exports, {
	Request: Request,
	Service: Service,
	request: request,
	service: service,
	get: get,
	post: post,
	put: put,
	del: del,
	parsers: parsers,
	file: multipart.file,
	data: multipart.data
});
