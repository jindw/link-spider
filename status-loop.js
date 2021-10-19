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

var oneCache ={
	get : function (url, cb) { 
		if(url == this.value && this.value[0]){
			cb(this.value[1],this.value[2]) 
		}else{
			cb()
		}
	},
	set : function (url, headers, body) {
		this.value = [url,headers,body]
	},
	getHeaders : function (url, cb) {
		if(url == this.value && this.value[0]){
			cb(this.value[1]) 
		}else{
			cb(null)
		}
	}
};
function Looper(){
	this.userAgent = firefox;
	this.cookie = cookiejar.CookieJar();
	this.referer = null
	this.cache = oneCache;
}

util.inherits(Looper, events.EventEmitter)
Looper.prototype.get = function (url, callback,referer) {
	var spider = this;
	function getRequestHeader(){
		var headers = copy(defaultHeaders);
		url = url.replace(/#.*/,'');
		var u = urlParse(url);
		//console.log(u,url)
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);

		
		headers['user-agent'] = spider.userAgent;
		var cookies = spider.cookie.getCookies(cookiejar.CookieAccessInfo(u.host, u.pathname));
		if (cookies) {
			headers.cookie = cookies.join(";");
		}
		return headers;
	}
	var headers = getRequestHeader();
	if(this.cache ){
		this.cache.getHeaders(url,(cachedHeaders)=>{
			if(cachedHeaders){
				if (cachedHeaders['last-modifed']) {
					headers['if-modified-since'] = cachedHeaders['last-modified'];
				}
				if (cachedHeaders.etag) {
					headers['if-none-match'] = cachedHeaders.etag;
				}
			}
			
			doRequest(this,url,callback,headers,this.referer);

		})
	}else{
		doRequest(this,url,callback,headers,this.referer);
	} 
	return this;
}
function doRequest(spider,url,callback,headers,referer){
	
	doGet(spider,url,headers,function (e, resp, body) {
		if (resp && (resp.statusCode == 301 || resp.statusCode == 302)) {
			//console.log(resp.headers,headers.location)
			doGet(spider,resp.headers.location,headers,arguments.callee);
			return;
		}
		
		//doRequest(spider);
		spider.emit('log', debug, 'Response received for '+url+'.')
		if (e) {
			spider.emit('log', error, url+'\t'+e);
			return;
		}
		if (resp.statusCode === 304) {
			spider.cache.get(url, function (headers,body) {
				handlerSpiderResponse(spider, callback,headers, body,url, referer, true);
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
		handlerSpiderResponse(spider, callback,resp.headers, body,url, referer, false);
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
 function handlerSpiderResponse(spider,callback,headers,body,url, referer,fromCache) {
	var u = urlParse(url);
 	//console.log(url)
 	//return null;
		var path = u.href.slice(u.href.indexOf(u.host)+u.host.length);
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
			return list;
		}
		spider.currentUrl = url;
		callback($,body)
		//$('img').each((i,a)=>console.log(i,a+''))
		//spider.callback( body, $);
		spider.currentUrl = null;
		
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
Looper.prototype.log = function (level) {
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
Looper.prototype.ok = function(callback){
	this.on('ok',callback);
	return this;
}

Looper.prototype.completeTask = function(){
	this.taskCount --;
	if(this.taskCount <1){
		this.emit('ok',this.urls);
	}
	return this;
};
var looper = new Looper();
setInterval(()=>{
	looper.get('http://news.baidu.com',($,body)=>{
		$('img').each((i,a)=>console.log(i,a+''))
	});
},1000)

//module.exports = function (options) {return new Looper(options || {})}


