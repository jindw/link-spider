exports.MongoCache = MongoCache;

exports.noCache ={
	get : function (url, cb) { cb(null,null) },
	set : function (url, headers, body) {},
	getHeaders : function (url, cb) {cb(null)}
};

exports.MemeryCache =MemeryCache;
function MemeryCache(limit){
	this.limit = limit||1024;
	this.cache = {};
	this.list = [];
}
MemeryCache.prototype = {
	get : function (url, cb) {
		var data = this.cache[url];
		cb(data && data[0],data && data[1]);
	},
	set : function (url, headers, body) {
		var index = this.list.indexOf(url);
		if(index>=0){
			if(index != this.list.length-1){
				this.list.splice(index,1);
				this.list.push(url)
			}
		}else{
			if(this.list.push(url)>this.limit){
				var removed = this.list.pop();
				delete this.cache[removed]
			}
		}
		this.cache[url] = [headers,body];
	},
	getHeaders : function (url, cb) {
		var data = this.cache[url];
		cb(data && data[0])
	}
};

function MongoCache(dburl){
	this.dburl = dburl || 'mongodb://localhost:27017/http-cache';
}

MongoCache.prototype = {
	close:function(){
		console.log('close db!')
		this.closed = true;
		if(this.db){
			this.db.close();
			this.db = null;
		}
	},
	get : function (url, callback) { 
		executeMongoAction(this,url,'get',callback);
	},
	set : function (url, headers, body) {
		executeMongoAction(this,url,'set',{headers:headers,body:body});
	},
	getHeaders : function (url, callback) {
		//console.log('get headers:',url)
		executeMongoAction(this,url,'getHeaders',callback);
	}
};
function executeMongoAction(thiz,url,action,args){
	if(thiz.err){
		//console.warn('mongo cache error:',thiz.err);
		thiz.err = null;
	}else if(thiz.db){
		var collection = thiz.db.collection('spider');
		var getAll = action == 'get';
		var fields = {headers:1};
		if(getAll && (fields.body=1) || action == 'getHeaders'){
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
		console.log('init database:',thiz.dburl);
		var MongoClient = require('mongodb').MongoClient;
		MongoClient.connect(thiz.dburl, function(err, db) {
			thiz.err = err;
			thiz.db = db;
			executeMongoAction(thiz,url,action,args);
		});
	}
}