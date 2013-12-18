// Copyright (c) 2012 Kuba Niegowski
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';


var util = require('util'),
    Stream = require('stream'),
    zlib = require('zlib'),
    Filter = require('./filter'),
    CrcStream = require('./crc'),
    constants = require('./constants');


var Packer = module.exports = function(options) {
    Stream.call(this);

    this._options = options;

    options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
    options.deflateLevel = options.deflateLevel || 9;
    options.deflateStrategy = options.deflateStrategy || 3;

    this.readable = true;
	
	this._paused = false;
	this._step = 0;
};
util.inherits(Packer, Stream);

Packer.prototype.pause = function() {
	this._paused = true;
	if (this._step === 4) {
		this._deflate.pause();
	}
};

Packer.prototype.resume = function() {
	this._paused = false;
	if (this._step === 5) {
		this._deflate.resume();
	} else {
		this._proc();
	}
};

Packer.prototype._proc = function() {
	if(this._paused) {
		return;
	}
	
    // Signature
    if (this._step === 0) {
		this._step++;
		this.emit('data', new Buffer(constants.PNG_SIGNATURE));
		process.nextTick(function() { this._proc(); }.bind(this));
	}
	if (this._step === 1) {
		this._step++;
		this.emit('data', this._packIHDR(this._width, this._height, this._colorType));
		process.nextTick(function() { this._proc(); }.bind(this));
	}
    
    if (this._step === 2) {
		this._step++;
		if (this._colorType === 3 && this._palette) {
        	this.emit('data', this._packPLTE(this._palette));
        	process.nextTick(function() { this._proc(); }.bind(this));
		}
    }
	
	if (this._step === 3) {
		this._step++;
        if (this._trans) {
            this.emit('data', this._packtRNS(this._trans));
			process.nextTick(function() { this._proc(); }.bind(this));
        }
	}
    
    // filter pixel data
	if (this._step === 4) {
		this._step++;
		
		var filter = new Filter(this._width, this._height, this._bpp, this._data, this._options);
		this._data = filter.filter();
	
		// compress it
		var deflate = zlib.createDeflate({
				chunkSize: this._options.deflateChunkSize,
				level: this._options.deflateLevel,
				strategy: this._options.deflateStrategy
			});
		deflate.on('error', this.emit.bind(this, 'error'));
	
		deflate.on('data', function(data) {
			this.emit('data', this._packIDAT(data));
		}.bind(this));
	
		deflate.on('end', function() {
			this.emit('data', this._packIEND());
			this.emit('end');
		}.bind(this));
	
		deflate.end(this._data);
		this._deflate = deflate;
	}
};

Packer.prototype.param = function(data, width, height, colorType, palette, trans) {
    this._colorType = typeof colorType !== 'number' ? 6 : colorType;
    this._data = data;
	this._width = width;
	this._height = height;
	this._bpp = this._colorType === 3 && palette ? 1 : 4;
	this._palette = palette;
	this._trans = trans;
	this._step = 0;
};

Packer.prototype.pack = function(data, width, height, colorType, palette, trans) {

    colorType = typeof colorType !== 'number' ? 6 : colorType;
    
    // Signature
    this.emit('data', new Buffer(constants.PNG_SIGNATURE));
    this.emit('data', this._packIHDR(width, height, colorType));

    var Bpp = 4;
    
    if (colorType === 3 && palette) {
        this.emit('data', this._packPLTE(palette));
        Bpp = 1;
        
        if (trans) {
            this.emit('data', this._packtRNS(trans));
        }
    }
    
    // filter pixel data
    var filter = new Filter(width, height, Bpp, data, this._options);
    data = filter.filter();

    // compress it
    var deflate = zlib.createDeflate({
            chunkSize: this._options.deflateChunkSize,
            level: this._options.deflateLevel,
            strategy: this._options.deflateStrategy
        });
    deflate.on('error', this.emit.bind(this, 'error'));

    deflate.on('data', function(data) {
        this.emit('data', this._packIDAT(data));
    }.bind(this));

    deflate.on('end', function() {
        this.emit('data', this._packIEND());
        this.emit('end');
    }.bind(this));

    deflate.end(data);
};

Packer.prototype._packChunk = function(type, data) {

    var len = (data ? data.length : 0),
        buf = new Buffer(len + 12);

    buf.writeUInt32BE(len, 0);
    buf.writeUInt32BE(type, 4);

    if (data) data.copy(buf, 8);

    buf.writeInt32BE(CrcStream.crc32(buf.slice(4, buf.length - 4)), buf.length - 4);
    return buf;
};

Packer.prototype._packIHDR = function(width, height, colorType) {

    var buf = new Buffer(13);
    buf.writeUInt32BE(width, 0);
    buf.writeUInt32BE(height, 4);
    buf[8] = 8;
    buf[9] = colorType; // colorType
    buf[10] = 0; // compression
    buf[11] = 0; // filter
    buf[12] = 0; // interlace

    return this._packChunk(constants.TYPE_IHDR, buf);
};

Packer.prototype._packIDAT = function(data) {
    return this._packChunk(constants.TYPE_IDAT, data);
};

Packer.prototype._packIEND = function() {
    return this._packChunk(constants.TYPE_IEND, null);
};

Packer.prototype._packPLTE = function(data) {
    return this._packChunk(constants.TYPE_PLTE, data);
};

Packer.prototype._packtRNS = function(data) {
    return this._packChunk(constants.TYPE_tRNS, data);
}
