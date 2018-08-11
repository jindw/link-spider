var urlResolve = require('url').resolve;
var xmldom = require('xmldom')
module.exports = function build$(spider,body,referrer){
	var selector ;
	function initSelector(){
		if(!selector){
			selector = buildSelector(body)
		}
		return selector;
	}
	
	return function $(selector,basenode){
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
				if(href && !/^\s*(?:data|javascript)\:/i.test(href)){
					if (!/^https?:/.test(href)) {
						href = urlResolve(referrer, href);
					}
					
					if(replace){
						href = replace(href)
					}
					c++;
					spider.get(href,referrer);
				}else{
					//console.log('@@',href)
				}
			})
			return c;
		}
		return list;
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