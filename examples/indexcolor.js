var fs = require('fs'),
	PNG = require('../lib/png').PNG;

function convertIndexImage(src) {
	let palette = new Map(),
		colorIndex = 0,
		data = src.data,
		indexData = new Uint8Array(src.width * src.height),
		alpha = false;
	
	for(let i = 0, j = 0, n = data.length; i < n; i += 4, j++) {
		let r = data[i],
			g = data[i + 1],
			b = data[i + 2],
			a = data[i + 3],
			color = (a << 24) | (b << 16) | (g << 8) | r;
		if(palette.has(color)) {
			indexData[j] = palette.get(color);
		} else {
			indexData[j] = colorIndex;
			palette.set(color, colorIndex);
			colorIndex++;
			
			if(a < 255) alpha = true;
		}
	}
	
	let paletteData = new Uint8Array(palette.size * 3),
		transData = new Uint8Array(palette.size);
	for (let [key, value] of palette) {
		let index = value * 3;
		paletteData[index] = key & 0xFF;
		paletteData[index + 1] = (key >> 8) & 0xFF;
		paletteData[index + 2] = (key >> 16) & 0xFF;
		transData[value] = (key >> 24) & 0xFF;
	}
	
	if(!alpha) transData = null;
	
	return { indexData, paletteData, transData };
}

fs.readFile(process.argv[2], (err, data) => {
	let png = new PNG();
	png.parse(data, (err, data) => {
		const image = convertIndexImage(data);
		
		let png = new PNG({
			width: data.width,
			height: data.height,
			colorType: 3,
			filterType: 0
		});
		
		png.data = Buffer.from(image.indexData.buffer);
		png.palette = Buffer.from(image.paletteData.buffer);
		if(image.transData) {
			png.transparency = Buffer.from(image.transData.buffer);
		}
		png.pack().pipe(fs.createWriteStream('out.png'));
	});
});
