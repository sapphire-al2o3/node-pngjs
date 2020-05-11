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


const util = require('util');
const { Readable } = require('stream');
const zlib = require('zlib');
const Filter = require('./filter');
const CrcStream = require('./crc');
const constants = require('./constants');

let Packer = module.exports = function(options) {
    Readable.call(this);

    this._options = options;

    options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
    options.deflateLevel = options.deflateLevel || 9;
    options.deflateStrategy = options.deflateStrategy || 3;

    this.readable = true;

    this._paused = false;
    this._step = 0;
    this._deflate = false;
    this._deflateHeader = 0x0000;
};
util.inherits(Packer, Readable);

Packer.prototype._read = function(size) {
    // Signature
    if (this._step === 0) {
        this._step++;
        this.push(Buffer.from(constants.PNG_SIGNATURE));
    }
    if (this._step === 1) {
        this._step++;
        this.push(this._packIHDR(this._width, this._height, this._colorType));
    }
    
    if (this._step === 2) {
        this._step++;
        if (this._colorType === 3 && this._palette) {
            this.push(this._packPLTE(this._palette));
        }
    }

    if (this._step === 3) {
        this._step++;
        if (this._trans) {
            this.push(this._packtRNS(this._trans));
        }
    }

    // filter pixel data
    if (this._step === 4) {
        this._step++;
        
        const filter = new Filter(this._width, this._height, this._bpp, this._data, this._options);
        this._data = filter.filter();

        // compress it
        const deflate = zlib.createDeflate({
                chunkSize: this._options.deflateChunkSize,
                level: this._options.deflateLevel,
                strategy: this._options.deflateStrategy
            });
        deflate.on('error', this.emit.bind(this, 'error'));

        deflate.on('data', function(data) {
            if(this._deflateHeader === 0 && !this._deflate) {
                this._deflateHeader = (data[0] << 8) | data[1];
                this._deflate = true;
            } else {
                this.push(this._packIDAT(data, this._deflateHeader));
                this._deflateHeader = 0;
            }
        }.bind(this));

        deflate.on('end', function() {
            this.push(this._packIEND());
            this.push(null);
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
    this.emit('data', Buffer.from(constants.PNG_SIGNATURE));
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
        if(this._deflateHeader === 0 && !this._deflate) {
            this._deflateHeader = (data[0] << 8) | data[1];
            this._deflate = true;
        } else {
            this.emit('data', this._packIDAT(data, this._deflateHeader));
            this._deflateHeader = 0;
        }
    }.bind(this));

    deflate.on('end', function() {
        this.emit('data', this._packIEND());
        this.emit('end');
    }.bind(this));

    deflate.end(data);
};

Packer.prototype._packChunk = function(type, data, header) {

    var len = (data ? data.length : 0);
    len += (header ? 2 : 0);
    var buf = Buffer.alloc(len + 12);
    var offset = 0;
    buf.writeUInt32BE(len, offset);
    offset += 4;
    buf.writeUInt32BE(type, offset);
    offset += 4;
    if (header) {
        buf.writeUInt16BE(header, offset);
        offset += 2;
    }
    if (data) data.copy(buf, offset);

    buf.writeInt32BE(CrcStream.crc32(buf.slice(4, buf.length - 4)), buf.length - 4);
    return buf;
};

Packer.prototype._packIHDR = function(width, height, colorType) {

    var buf = Buffer.alloc(13);
    buf.writeUInt32BE(width, 0);
    buf.writeUInt32BE(height, 4);
    buf[8] = 8;
    buf[9] = colorType; // colorType
    buf[10] = 0; // compression
    buf[11] = 0; // filter
    buf[12] = 0; // interlace

    return this._packChunk(constants.TYPE_IHDR, buf);
};

Packer.prototype._packIDAT = function(data, header) {
    return this._packChunk(constants.TYPE_IDAT, data, header);
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
