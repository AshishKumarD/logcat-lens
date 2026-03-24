// @ts-ignore
const vsc = window.vsc || acquireVsCodeApi();
// @ts-ignore
window.vsc = vsc;

class HTMLElementBase extends HTMLElement {
	static salt = 0;
	handle;

	constructor() {
		super();

		this.handle = `${this.constructor.name}_${HTMLElementBase.salt++}`;
		window[this.handle] = this;

		window.addEventListener('message', (event) => this.onMessage(event));
	}

	postMessage(msg) {
		vsc.postMessage(msg);
	}
	onMessage(event) {
		console.log(event);
	}

	setState(state) {
		vsc.setState(state);
	}
	getState() {
		return vsc.getState();
	}

	render(template) {
		this.innerHTML = template;

		// add direct access to ID'd elements
		this.querySelectorAll('[id]').forEach(elem => {
			const camel = elem.id.replace(/-./g, x => x[1].toUpperCase());
			this[camel] = elem;
		});
	}
}
