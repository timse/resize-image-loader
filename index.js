// Options
//  @sizes Array of Integers
//    require('resize-image?sizes[]=200w,sizes[]=900w!./myImage.jpg');
//
//  @placeholder Integers (not compatible with sizes)
//    require('resize-image?placeholder=500!./myImage.jpg');
//  @blur Integers (not compatible with sizes)
//    require('resize-image?placeholder&blur=10!./myImage.jpg');
//
//  @format String ('jpg', 'gif', 'webp', 'png')
//    require('resize-image?format=webp!./myImage.jpg');

var debug = require('debug')('resize-image-loader');
var gm = null;
var hasImageMagick = false;
try {
  require('child_process').execSync("gm -help")
  gm = require('gm').subClass({ imageMagick: true });
} catch(e){
  console.info('resize-image-loader: ImageMagick not installed. Falling back to LWIP.');
}


var lwip = require('lwip');
var sizeOf = require('image-size');
var Datauri = require('datauri');
var fs = require('fs');
var loaderUtils = require('loader-utils');

var defaultSizes = ['320w','960w','2048w'];
var defaultBlur = 40;
var defaultPlaceholderSize = 20;

var createBlur = function(buffer, ext, defaultBlur, height, width){
  var uri = new Datauri().format('.'+ext, buffer).content;
  var blur =  "<svg xmlns='http://www.w3.org/2000/svg' width='100%' viewBox='0 0 " + width + " " + height + "'>" +
  "<defs><filter id='puppybits'><feGaussianBlur in='SourceGraphic' stdDeviation='" + defaultBlur + "'/></filter></defs>" +
  "<image width='100%' height='100%' xmlns:xlink='http://www.w3.org/1999/xlink' xlink:href='" + uri + "' filter='url(#puppybits)'></image>" +
  "</svg>";
  var micro = new Datauri().format('.svg', new Buffer(blur, 'utf8')).content;
  var response = {size:{height:height, width:width}, placeholder:micro};
};

var queue = (function(q, c){
  var max = 10;
  var push = function(fnc){
      q.push(fnc);
      canDo();
    },
    canDo = function(){
      if(c < max && q.length > 0){
        debug(q.length + " images remaining.");
        c++;
        q.shift()(next);
      }
    },
    next = function(){
      setTimeout(function(){
        c--;
        canDo();
      },0);
    };
    return {push:push, next:next};
}([], 0));

function createPlaceholder(content, placeholder, ext, blur, files){
  return function(next){
    var source = sizeOf(content);
    var ratio = source.width/source.height;
    var width = placeholder
    var height = Math.floor(placeholder / ratio)

    if (gm){
      gm(content)
        .resize(width)
        .toBuffer(ext, function(err, buffer){
          if (!buffer) return;
          debug("placeholder: ", height, width);
          var response = createBlur(buffer, ext, defaultBlur, height, width);
          next(response);
        });
    } else {
      lwip.open(content, source.type, function(err, image) {
        image.batch()
          .resize(width, height)
          .toBuffer(source.type, function(err, buffer) {
            if (!buffer) return;
            debug("placeholder: " + JSON.stringify(source));
            var response = createBlur(buffer, ext, defaultBlur, source.height, source.width);
            next(response);
          });
      });
    };
  };
}

function createResponsiveImages(content, sizes, ext, files, emitFile){
  return function(next){
    var count = 0;
    var images = [];
    var imgset = files.map(function(file, i){ return file + ' ' + sizes[i] + ' '; }).join(',');
    var source = sizeOf(content);
    var ratio = source.width/source.height;

    sizes.map(function(size, i){
      size = parseInt(size);
      var width = size
      var height = Math.floor(size / ratio)

      if (gm){
        gm(content)
          .resize(size)
          .toBuffer(ext, function(err, buf){
            if (buf){
              debug('srcset: ' + imgset);
              images[i] = buf;
              emitFile(files[i], buf);
            }

            count++;
            if (count >= files.length) {
              var response = {srcset:imgset};
              next(response);
            }
        });
      } else {
        lwip.open(content, ext, function(err, image) {
          image.batch()
            .resize(width, height)
            .toBuffer(ext, function(err, buffer) {
              if (buffer){
                debug('srcset: ' + imgset);
                images[i] = buffer;
                emitFile(files[i], buffer);
              }

              count++;
              if (count >= files.length) {
                var response = {srcset:imgset};
                next(response);
              }
            });
        });
      }
    });
  };
}

function createOutput(output) {
    return "module.exports = " + JSON.stringify(output);
}

module.exports = function(content) {
  var idx = this.loaderIndex;

  // ignore content from previous loader because it could be datauri
  content = fs.readFileSync(this.resourcePath);

  var query = (this.query !== '' ? this.query : this.loaders[0].query);
  query = loaderUtils.parseQuery(query);
  var size = !query.sizes && !query.placeholder && defaultSizes || [];

  query.sizes = (query.sizes && !Array.isArray(query.sizes) && [query.sizes]) || query.sizes || size;

  var callback = this.async();
  if(!this.emitFile) throw new Error("emitFile is required from module system");
  this.cacheable && this.cacheable();
  this.addDependency(this.resourcePath);

  if (this.debug === true && query.bypassOnDebug === true) {
    // Bypass processing while on watch mode
    return callback(null, content);
  } else {

    var paths = this.resourcePath.split('/');
    var file = paths[paths.length - 1];
    var name = file.slice(0,file.lastIndexOf('.'));
    var ext = file.slice(file.lastIndexOf('.')+1, file.length);
    var sizes = query.sizes.map(function(s){ return s; });
    var files = sizes.map(function(size, i){ return name + '-' + size + '.' + ext; });
    var emitFile = this.emitFile;

    var task1 = null,
      task2 = null;
    if (query.placeholder) {
      query.placeholder = parseInt(query.placeholder) || defaultPlaceholderSize;
      query.blur = query.blur || defaultBlur;

      task1 = createPlaceholder(content, query.placeholder, ext, query.blur, files);
    }

    if (sizes.length >= 1){
      if (!task1) {
        task1 = createResponsiveImages(content, sizes, ext, files, emitFile);
      } else {
        task2 = createResponsiveImages(content, sizes, ext, files, emitFile);
      }
    }

    queue.push((function(t1, t2, callback){
      return function(next){
        if (t2){
          t2(function(result){
            t1(function(result2){
              if (result2){
                Object.keys(result2).map(function(key){
                  result[key] = result2[key];
                });
              }
              debug("result", JSON.stringify(result));
              callback(null, "module.exports = '"+JSON.stringify(result)+"'");
              next();
            });
          });
          return;
        }


        t1(function(result){
          debug("result", JSON.stringify(result));
          callback(null, "module.exports = '"+JSON.stringify(result)+"'");
          next();
        });
      };
    }(task1, task2, callback)));
  }
};

module.exports.raw = true; // get buffer stream instead of utf8 string
