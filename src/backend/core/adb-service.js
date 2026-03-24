const { spawn, exec } = require('child_process');
const { platform } = require('os');
const EventEmitter = require('events');

class ADBService extends EventEmitter {
	logcatProcess;

	listDevices() {
		return new Promise((resolve, reject) => {
			exec('adb devices -l', (error, stdout, stderr) => {
				if (error) return reject(error);

				// sample: R5CX912W25A            device product:e3qxxx model:SM_S928B device:e3q transport_id:1
				const lines = stdout.split('List of devices attached').pop().trim()
					.split('\n').map(l => l.trim()).filter(l => l);

				const devices = lines.map(line => {
					const [id, model] = line.match(/(^\w+)|(model:\w+)/g);
					return { id, model: model.split(':').pop(), raw: line };
				});

				resolve(devices);
			});
		});
	}

	listPackages(deviceId) {
		return new Promise((resolve, reject) => {
			exec(`adb -s ${deviceId} shell pm list packages -3`, (error, stdout, stderr) => {
				if (error) return reject(error);
				const packages = stdout.split('\n')
					.map(l => l.replace('package:', '').trim())
					.filter(Boolean)
					.sort();
				resolve(packages);
			});
		});
	}

	listTags(deviceId) {
		return new Promise((resolve, reject) => {
			exec(`adb -s ${deviceId} logcat -d -v tag`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
				if (error) return reject(error);
				const tags = new Set();
				stdout.split('\n').forEach(line => {
					const match = line.match(/^[VDIWEF]\/([^(\s:]+)/);
					if (match) tags.add(match[1].trim());
				});
				resolve([...tags].sort());
			});
		});
	}

	getUID(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			const filter = platform() == 'win32' ? 'FINDSTR' : 'grep';
			exec(`adb -s ${deviceId} shell dumpsys package ${packageName} | ${filter} uid`, (error, stdout, stderr) => {
				if (error) return reject(error);

				// sample: uid=10520 gids=[] type=0 prot=signature
				const uid = stdout.trim().match(/uid=(\d+)/)?.[1];
				uid ? resolve(uid) : reject('Package not found.');
			});
		});
	}

	refreshPidMap(deviceId) {
		exec(`adb -s ${deviceId} shell ps -A -o PID,NAME`, (error, stdout) => {
			if (error) return;
			this.pidMap = {};
			stdout.split('\n').forEach(line => {
				const match = line.trim().match(/^(\d+)\s+(.+)$/);
				if (match) this.pidMap[match[1]] = match[2];
			});
		});
	}

	async start({ deviceId, packages, packageName, tag, level, search }) {
		this.stop();

		if (!deviceId) throw new Error('Please connect to a device and make sure it is authorized.');

		// Store params for restart
		this.lastParams = { deviceId, packages, packageName, tag, level, search };

		// Build PID→package map and refresh every 30s
		this.pidMap = this.pidMap || {};
		this.refreshPidMap(deviceId);
		this._pidInterval = setInterval(() => this.refreshPidMap(deviceId), 30000);

		// Always stream everything at Verbose — all filtering is client-side
		const args = ['-s', deviceId, 'logcat', '*:V'];

		this.logcatProcess = spawn('adb', args);

		// Buffer partial lines across data chunks
		let lineBuffer = '';

		this.logcatProcess.stdout.on('data', (data) => {
			lineBuffer += data.toString();
			const lines = lineBuffer.split('\n');
			// Keep last element (may be incomplete line)
			lineBuffer = lines.pop();

			const batch = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;

				const parts = line.match(/^(\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s+(.*)$/);
				if (!parts) continue;

				batch.push({
					timestamp: parts[1],
					pid: parts[2],
					tid: parts[3],
					priority: parts[4],
					tag: parts[5],
					message: parts[6],
					pkg: this.pidMap?.[parts[2]] || ''
				});
			}

			// Emit each log individually for compatibility with the message protocol
			for (let i = 0; i < batch.length; i++) {
				this.emit('adbevent', {
					type: 'adb.log',
					data: batch[i]
				});
			}
		});

		this.logcatProcess.stderr.on('data', (data) => {
			console.error(`adb stderr: ${data}`);
			this.emit('adbevent', {
				type: 'adb.error',
				data: data
			});
		});

		this.logcatProcess.on('close', (code) => {
			console.log(`adb process exited with code ${code}`);
			this.emit('adbevent', {
				type: 'adb.closed',
				data: code
			});
		});
	}

	stop() {
		this.logcatProcess?.kill();
		this.logcatProcess = null;
		clearInterval(this._pidInterval);
	}

	async restart(params) {
		this.stop();
		this.clear();
		await this.start(params || this.lastParams);
	}

	clear() {
		exec(`adb logcat -c`);
	}
}

module.exports = ADBService;
