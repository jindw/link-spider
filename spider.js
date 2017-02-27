var request = require('request')
	, http = require('http')
	, fs = require('fs')
	, xmldom = require('xmldom')
	, urlParse = require('url').parse
	, urlResolve = require('url').resolve
	, routes = require('routes')
	, events = require('events')
	, util = require('util')
	, iconv = require('iconv-lite')
	, cookiejar = require('cookiejar')
	;

var defaultHeaders = 
	{ 'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5"
	, 'accept-language': 'en-US,en;q=0.8'
	, 'accept-charset':	'utf-8;q=0.7,*;q=0.3'
	}

var firefox = "Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4"

var copy = function (obj) {
	var n = {}
	for (i in obj) {
		n[i] = obj[i];
	}
	return n
}

var debug = 1
	, info = 50
	, error = 100
	;
var logLevels = {debug:debug, info:info, error:error, 1:'debug', 50:'info', 100:'error'}

var noCache ={
	get : function (url, cb) { cb(null,null) },
	set : function (url, headers, body) {},
	getHeaders : function (url, cb) {cb(null)}
};

function Spider (options) {
	this.update = options.update || true
	this.maxSockets = options.maxSockets || 4;
	this.requestInterval = options.requestInterval || 500;
	this.userAgent = options.userAgent || firefox;
	this.minTTL = options.minTTL;
	this.cache = options.cache || new MongoCache('mongodb://localhost:27017/http-cache');
	this.pool = options.pool || {maxSockets: this.maxSockets};
	this.options = options;
	this.currentUrl = null;
	this.routers = {};
	this.urls = [];
	this.waitUrls = [];
	this.runUrls = [];
	this.taskCount = 0;
	this.cookie = cookiejar.CookieJar();
	if(/^mongodb:\/\//.test(this.cache)){
		this.cache = new MongoCache('mongodb://localhost:27017/http-cache')
	}
}
util.inherits(Spider, events.EventEmitter)
Spider.prototype.get = function (url, referer) {
	function getRequestHeader(){
		var headers = copy(defaultHeaders);
		url = url.replace(/#.*/,'');
		if (spider.urls.indexOf(url) !== -1) {
			// Already handled this request
			spider.emit('log', debug, 'Already received one get request for '+url+'. skipping.')
			return;
		} 
		var u = urlParse(url);
		//console.log(u,url)
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);
		if (!spider.routers[u.host]) {
			spider.emit('log', debug, 'No routes for host: '+u.host+'. skipping.')
			return;
		}
		spider.urls.push(url);
		//console.log(this.routers[u.host],'\n\n',u.href.slice(u.href.indexOf(u.host)+u.host.length))
		if (!spider.routers[u.host].match(path)) {
			spider.emit('log', debug, 'No routes for path '+path+'. skipping.')
			return;
		}
		
		spider.taskCount ++;
		if (referer) headers.referer = referer;
		headers['user-agent'] = spider.userAgent;
		var cookies = spider.cookie.getCookies(cookiejar.CookieAccessInfo(u.host, u.pathname));
		if (cookies) {
			headers.cookie = cookies.join(";");
		}
		return headers;
	}
	referer = referer || this.currentUrl;	
	var spider = this;
	var headers = getRequestHeader();
	headers && this.cache.getHeaders(url, function (cachedHeaders) {
		if (cachedHeaders) {
			var update = spider.update;
			if(update && cachedHeaders.expires){
				var ttl = cachedHeaders.expires;
				ttl = ttl &&  Date.parse(ttl) || 0;
				if(ttl > +new Date()){
					update = false;
				}
			}
			//update = false;
			//console.log(update)
			if(!update){
				spider.cache.get(url, function (headers,body) {
					//console.log(url,'@@@load  cache:',body == null)
					handlerSpiderResponse(spider, headers, body,url, referer, true)
					spider.completeTask();
				});
				return;
			}
			if (cachedHeaders['last-modifed']) {
				headers['if-modified-since'] = cachedHeaders['last-modified'];
			}
			if (cachedHeaders.etag) {
				headers['if-none-match'] = cachedHeaders.etag;
			}
			
		}
		doRequest(spider,url,headers,referer)
	});
	return this;
}
function doRequest(spider,url,headers,referer){
	var waitUrls = spider.waitUrls;
	var runUrls = spider.runUrls;
	if(url){
		if(runUrls.length){//single run url
			waitUrls.push(url,headers,referer);
			return ;
		}
	}else{
		referer = waitUrls.pop();
		headers = waitUrls.pop();
		url = waitUrls.pop();
		if(!url){
			return;
		}
	}
	runUrls.push(url)
	console.info('send request:',url,';wait:',waitUrls.length)
	
	
	
	doGet(spider,url,headers,function (e, resp, body) {
		if (resp && (resp.statusCode == 301 || resp.statusCode == 302)) {
			//console.log(resp.headers,headers.location)
			doGet(spider,resp.headers.location,headers,arguments.callee);
			return;
		}
		
		var i = runUrls.indexOf(url);
		runUrls.splice(i,1)
		doRequest(spider);
		spider.emit('log', debug, 'Response received for '+url+'.')
		if (e) {
			spider.emit('log', error, url+'\t'+e);
			return;
		}
		if (resp.statusCode === 304) {
			spider.cache.get(url, function (headers,body) {
				handlerSpiderResponse(spider, headers, body,url, referer, true);
				spider.completeTask();
			});
			return;
		} else if (resp.statusCode !== 200) {
			spider.emit('log', debug, 'Request did not return 200. '+resp.statusCode+' returned \t'+url);
			spider.completeTask();
			return;
		//} else if (!resp.headers['content-type'] || resp.headers['content-type'].indexOf('html') === -1) {
		//	spider.emit('log', debug, 'Content-Type does not match. '+url);
		//	spider.completeTask();
		//	return;
		}
		if (resp.headers['set-cookie']) {
			try { spider.cookie.setCookies(resp.headers['set-cookie']) }
			catch(e) {}
		}
		//console.log(headers,resp.headers)
		spider.cache.set(url, resp.headers, body);
		handlerSpiderResponse(spider, resp.headers, body,url, referer, false);
		spider.completeTask();
	})
}
function doGet(spider,url,headers,callback){
	var isJD = /^http:\/\/\w+\.jd\.com\//.test(url)
	if(isJD || /.(?:jpg|mp3)$/.test(url)){
		var buf;
		function appendData(chunk) {
			//console.log(url,typeof chunk)
			if(buf){
				buf = Buffer.concat([buf,chunk])
			}else{
				buf = chunk;//new Buffer();
			}
		}
		var m =url.match( /^(https?):\/\/([^\/:]+)(:\d+)?(\/.*)$/)
		var options = {
			hostname: m[2],
			port: m[3]||80,
			path: m[4],
			method: 'GET',
			headers: headers
		};
		(m[1] == 'http'?http:https).get(options, function(res) {
			//res.setEncoding('utf8');
			res.on('data', appendData);
			res.on('end', function(chunk) {
				chunk && appendData(chunk);
				if(isJD){
					buf = iconv.decode(buf, 'GBK');
				}
				callback(null,res,buf)
			})
		}).on('error', function(e){
			callback(e,res)
		});
	}else{
		request.get({url:url, headers:headers, pool:spider.pool}, callback);
	}
	
}
Spider.prototype.route = function (hosts, pattern, cb) {
	var spider = this;
	if (typeof hosts === 'string') {
		hosts = [hosts];
	}
	hosts.forEach(function (host) {
		if (!spider.routers[host]) spider.routers[host] = new routes.Router();
		spider.routers[host].addRoute(pattern, cb);
	})
	return spider;
}
 function handlerSpiderResponse(spider,headers,body,url, referer,fromCache) {
	var u = urlParse(url);
 	//console.log(url)
 	//return null;
	if (spider.routers[u.host]) {
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);
		var r = spider.routers[u.host].match(path);
		r.spider = spider;
		r.headers = headers
		r.body = body
		r.url = u;
		r.fromCache = fromCache;
		var selector ;
		function initSelector(){
			if(!selector){
				selector = buildSelector(body)
			}
			return selector;
		}
		
		function $(selector,basenode){
			//console.log('selector:',selector,'$$$',basenode)
			var list = initSelector().select(selector,basenode) ||[];
			list.each = function(fn){
				for(var i=0;i<list.length;i++){
					fn(i,list[i]);
				}
			}
			list.spider = function(replace){
				var c = 0;
				list.each(function(i,p){
					var href= p.getAttribute('href') || p.getAttribute('src');
					if(href && !/^\s*javascript\:/.test(href)){
						if (!/^https?:/.test(href)) {
							href = urlResolve(url, href);
						}
						
						if(replace){
							href = replace(href)
						}
						c++;
						spider.get(href,url);
					}else{
						//console.log('@@',href)
					}
				})
				return c;
			}
			return list;
		}
		spider.currentUrl = url;
		r.fn.call(r, body, $);
		spider.currentUrl = null;
	}	
}
function buildSelector(body){
	var docParser = new xmldom.DOMParser({errorHandler:function(level,msg){}});
	var doc = docParser.parseFromString(body,'text/html');
	if(!doc){
		console.log('invalid doc',body)
	}
	var elementPrototype = doc.documentElement.constructor.prototype;
	if(!('innerHTML' in elementPrototype)){
		Object.defineProperty(elementPrototype,'innerHTML',{
			get:function(){
				return this.childNodes.toString();
			}
		})
		Object.defineProperty(elementPrototype,'outerHTML',{
			get:function(){
				return this.toString();
			}
		})
	}
	doc.getAttributeNode = function(){
		return this.documentElement.getAttributeNode.apply(this.documentElement,arguments);
	}
	//console.log(root)
	var nwmatcher = require('nwmatcher');
	var selector = nwmatcher({document:doc});
	selector.configure( { USE_QSAPI: false, VERBOSITY: true } );
	return selector;
}
Spider.prototype.log = function (level) {
	if (typeof level === 'string'){
		level = logLevels[level];
	}
	this.on('log', function (l, text) {
		if (l >= level) {
			console.log('['+(logLevels[l] || l)+']', text)
		}
	})
	return this;
}
Spider.prototype.ok = function(callback){
	this.on('ok',callback);
	return this;
}

Spider.prototype.completeTask = function(){
	this.taskCount --;
	if(this.taskCount <1){
		this.emit('ok',this.urls);
	}
	return this;
};

function MongoCache(dburl){
	this.dburl = dburl || 'mongodb://localhost:27017/http-cache';
}

MongoCache.prototype = {
	execute:function(url,type,args){
		var thiz = this;
		if(thiz.err){
			//console.warn('mongo cache error:',thiz.err);
			thiz.err = null;
		}else if(this.db){
			var collection = this.db.collection('spider');
			var getAll = type == 'get';
			var fields = {headers:1};
			if(getAll && (fields.body=1) || type == 'getHeaders'){
				collection.findOne({url:url},{fields:fields},
					function(err,result){
						if(result){
							//console.log(url,type,getAll,fields,result.body == null)
							args(result.headers,result.body)
						}else{
							args();
						}
						thiz.closed && thiz.close();
					});
			}else{//put
				//collection.save({url:url,headers:arg1,body:arg2},callback);
				//if(!arg2){console.error('cache body is null',url);}
				collection.updateOne({url:url}, {$set:args}, {upsert:true,w:1},callback);
				function callback(err,data){
					//console.log("save cache:",url)
					//collection.findOne({url:url},{fields:{body:1}},function(err,result){console.log('saved data:',url,result.body.length);});
					thiz.closed && thiz.close();
				};
			}
		}else{
			console.log('init database:',this.dburl);
			var MongoClient = require('mongodb').MongoClient;
			MongoClient.connect(this.dburl, function(err, db) {
				thiz.err = err;
				thiz.db = db;
				thiz.execute(url,type,args);
			});
		}
	},
	close:function(){
		console.log('close db!')
		this.closed = true;
		if(this.db){
			this.db.close();
			this.db = null;
		}
	},
	get : function (url, callback) { 
		this.execute(url,'get',callback);
	},
	set : function (url, headers, body) {
		this.execute(url,'set',{headers:headers,body:body});
	},
	getHeaders : function (url, callback) {
		//console.log('get headers:',url)
		this.execute(url,'getHeaders',callback);
	}
};
module.exports = function (options) {return new Spider(options || {})}
module.exports.MongoCache = MongoCache;


