// omp extension: gives an omp session an xmsg inbox.
//   omp -e <xmsg>/omp/xmsg-inbox.ts
// On start it opens a unix socket, registers itself in $XMSG_HOME/omp/<pid>.json
// and exports XMSG_SELF so `xmsg send` run from this session's shell knows who
// is sending. Each JSON line {id, text} on the socket becomes a user message.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export default function xmsgInbox(pi: any) {
	const home = process.env.XMSG_HOME || join(homedir(), ".xmsg");
	const sockDir = join(home, "s");
	const regDir = join(home, "omp");
	mkdirSync(sockDir, { recursive: true, mode: 0o700 });
	mkdirSync(regDir, { recursive: true, mode: 0o700 });

	const name = process.env.XMSG_NAME || `${basename(process.cwd())}-${(process.pid % 256).toString(16).padStart(2, "0")}`;
	const socket = join(sockDir, `omp-${process.pid}.sock`);
	const reg = join(regDir, `${process.pid}.json`);
	process.env.XMSG_SELF = `omp:${name}`;

	rmSync(socket, { force: true });
	let buf = "";
	Bun.listen({
		unix: socket,
		socket: {
			data(sock, chunk) {
				buf += chunk.toString();
				let i;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (!line.trim()) continue;
					try {
						const m = JSON.parse(line);
						pi.sendUserMessage(String(m.text), { deliverAs: "aside" });
						sock.write(JSON.stringify({ ok: true, id: m.id }) + "\n");
					} catch (e) {
						sock.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
					}
				}
			},
		},
	});
	writeFileSync(reg, JSON.stringify({ pid: process.pid, name, socket, cwd: process.cwd(), started: Date.now() }) + "\n", { mode: 0o600 });

	pi.on("session_shutdown", async () => {
		rmSync(socket, { force: true });
		rmSync(reg, { force: true });
	});
}
