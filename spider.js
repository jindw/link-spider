var request = require('request')
	, http = require('http')
	, fs = require('fs')
	, urlParse = require('url').parse
	, routes = require('routes')
	, iconv = require('iconv-lite')
	, cookiejar = require('cookiejar')
	;
var html = require('./html');
var MongoCache = require('./cache').MongoCache;
var MemeryCache = require('./cache').MemeryCache

var defaultHeaders = 
	{ 'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,image/png,*/*;q=0.5"
	, 'accept-language': 'en-US,en;q=0.8'
	, 'accept-charset':	'utf-8;q=0.7,*;q=0.3'
	}

var firefox = "Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4"
var spider = firefox + ' spider';
firefox = spider

var debug = 1
	, info = 50
	, error = 100
	;
var logLevels = {debug:debug, info:info, error:error, 1:'debug', 50:'info', 100:'error'}

function Spider (options) {
	this.update = options.update || true
	this.maxSockets = options.maxSockets || 4;
	this.requestInterval = options.requestInterval || 500;
	this.userAgent = options.userAgent || firefox;
	this.minTTL = options.minTTL;
	this.pool = options.pool || {maxSockets: this.maxSockets};
	this.options = options;
	this.currentUrl = null;
	this.routers = {};
	this.urls = [];
	this.waitUrls = [];
	this.runUrls = [];
	this.taskCount = 0;
	this.cookie = cookiejar.CookieJar();
	if(/^mongodb:\/\//.test(options.cache)){
		this.cache = new MongoCache(options.cache)
	}else{
		this.cache = options.cache || new MemeryCache();
	}
}
Spider.prototype.get = function (url, referer) {
	function getRequestHeader(){
		var reqHeaders = Object.create(defaultHeaders);
		url = url.replace(/#.*/,'');
		if (spider.urls.indexOf(url) !== -1) {
			// Already handled this request
			console.info('Already received one get request for '+url+'. skipping.')
			return;
		} 
		var u = urlParse(url);
		//console.log(u,url)
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);
		if (!spider.routers[u.host]) {
			console.info( 'No routes for host: '+u.host+'. skipping.')
			return;
		}
		spider.urls.push(url);
		//console.log(this.routers[u.host],'\n\n',u.href.slice(u.href.indexOf(u.host)+u.host.length))
		if (!spider.routers[u.host].match(path)) {
			console.warn( 'No routes for path '+path+'. skipping.')
			return;
		}
		
		spider.taskCount ++;
		if (referer) reqHeaders.referer = referer;
		reqHeaders['user-agent'] = spider.userAgent;
		var cookies = spider.cookie.getCookies(cookiejar.CookieAccessInfo(u.host, u.pathname));
		if (cookies) {
			reqHeaders.cookie = cookies.join(";");
		}
		return reqHeaders;
	}
	referer = referer || this.currentUrl;	
	var spider = this;
	var reqHeaders = getRequestHeader();
	//console.log(url,JSON.stringify(reqHeaders))
	reqHeaders && this.cache.getHeaders(url, function (cachedHeaders) {
		
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
				spider.cache.get(url, function (respHeaders,body) {
					//console.log(url,'@@@load  cache:',body == null)
					handlerSpiderResponse(spider, respHeaders, body,url, referer, true)
					spider.completeTask();
				});
				return;
			}
			if (cachedHeaders['last-modifed']) {
				reqHeaders['if-modified-since'] = cachedHeaders['last-modified'];
			}
			if (cachedHeaders.etag) {
				reqHeaders['if-none-match'] = cachedHeaders.etag;
			}
			
		}
		doRequest(spider,url,reqHeaders,referer)
	});
	return this;
}
function doRequest(spider,url,reqHeaders,referer){
	var waitUrls = spider.waitUrls;
	var runUrls = spider.runUrls;
	if(url){
		if(runUrls.length){//single run url
			waitUrls.push(url,reqHeaders,referer);
			return ;
		}
	}else{
		referer = waitUrls.pop();
		reqHeaders = waitUrls.pop();
		url = waitUrls.pop();
		if(!url){
			return;
		}
	}
	runUrls.push(url)
	//console.info('send request:',url,';wait:',[runUrls.length,waitUrls.length])
	
	doGet(spider,url,reqHeaders,function (e, resp, body) {
		
		if (e) {
			console.error( url+'\t'+e);
			return;
		}
		//TODO:cache control
		//console.log('do get' ,url)
		var respHeaders = resp.headers;
		if (resp && (resp.statusCode == 301 || resp.statusCode == 302)) {
			//console.log(resp.headers,headers.location)
			doGet(spider,respHeaders.location,respHeaders,arguments.callee);
			return;
		}
		
		var i = runUrls.indexOf(url);
		runUrls.splice(i,1)
		doRequest(spider);
		console.info( 'Response received for '+url+'.')
		if (resp.statusCode === 304) {
			spider.cache.get(url, function (respHeaders,body) {
				handlerSpiderResponse(spider, respHeaders, body,url, referer, true);
				spider.completeTask();
			});
			return;
		} else if (resp.statusCode !== 200) {
			console.info( 'Request did not return 200. '+resp.statusCode+' returned \t'+url);
			spider.completeTask();
			return;
		//} else if (!resp.headers['content-type'] || resp.headers['content-type'].indexOf('html') === -1) {
		//	console.info( 'Content-Type does not match. '+url);
		//	spider.completeTask();
		//	return;
		}
		if (respHeaders['set-cookie']) {
			try { spider.cookie.setCookies(respHeaders['set-cookie']) }
			catch(e) {}
		}
		//console.log(resp.headers)
		
		spider.cache.set(url, respHeaders, body);
		handlerSpiderResponse(spider, respHeaders, body,url, referer, false);
		spider.completeTask();
	})
}
function doGet(spider,url,reqHeaders,callback){
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
			headers: reqHeaders
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
		//console.log({url:url, headers:reqHeaders, pool:spider.pool},callback)
		request.get({url:url, headers:reqHeaders, pool:spider.pool}, callback);
	}
	
}
Spider.prototype.route = function (hosts, pattern, cb) {
	var spider = this;
	if (typeof hosts === 'string') {
		hosts = [hosts];
	}
	hosts.forEach(function (host) {
		var router = spider.routers[host];
		if (!router) {
			router = spider.routers[host] = new routes.Router();
		}
		if(pattern instanceof Array){
			pattern.forEach(function(pattern){
				router.addRoute(pattern, cb);
			})
		}else{
			router.addRoute(pattern, cb);
		}
		
	})
	return spider;
}
 function handlerSpiderResponse(spider,respHeaders,body,url, referer,fromCache) {
	var u = urlParse(url);
 	//console.log(url)
 	//return null;
	if (spider.routers[u.host]) {
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);
		var r = spider.routers[u.host].match(path);
		var $ = html(spider,body,url);
		//r.headers = respHeaders
		//r.fromCache = fromCache;
		spider.currentUrl = url;
		r.fn.call(spider,url,respHeaders, body, fromCache,$);
		spider.currentUrl = null;
	}	
}

Spider.prototype.completeTask = function(){
	this.taskCount --;
	//console.log('taskCount:%s',this.taskCount)
	if(this.taskCount <1){
		if(this.ok){
			this.ok(this.urls);
		}
		if(this.cache && this.cache.close instanceof Function){
			this.cache.close();
		}
	}
	return this;
};

module.exports =  Spider


