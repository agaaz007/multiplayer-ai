import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

/** Transparent local stdio transport. Native tool schemas/results are unchanged.
 * Credentials and provider processes stay outside the task-agent sandbox. */
export async function nativeSequenceTransport(socket: string, command: string, args: string[], env: NodeJS.ProcessEnv,
  cwd: string, record: (direction: string, message: unknown) => void, permit?: (message: any) => string | null) {
  if (fs.existsSync(socket)) throw new Error('refusing an existing native transport socket');
  // macOS truncates unix socket paths beyond sun_path (104 bytes) silently; a truncated path collides across stages.
  if (Buffer.byteLength(socket) > 100) throw new Error(`native transport socket path too long for macOS (${Buffer.byteLength(socket)} bytes): ${socket}`);
  let child: ReturnType<typeof spawn> | undefined;
  let connection: net.Socket | undefined;
  let connected = false;
  const server = net.createServer(client => {
    if (connected) { client.destroy(); return; }
    connected = true; connection = client;
    child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached:true });
    const stop=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{child?.kill('SIGKILL');}};
    const traceLines = (direction: string) => {
      let buffer = '';
      return (chunk: Buffer) => { buffer += chunk.toString();
        if (buffer.length > (8 << 20)) { record('transport-error', 'oversized protocol message'); stop(); client.destroy(); return; }
        for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try { record(direction, JSON.parse(line)); } catch { record(direction, { nonJson: true, byteLength: line.length }); }
        }
      };
    };
    let incoming='';
    client.on('data',chunk=>{incoming+=chunk.toString();if(incoming.length>(8<<20)){stop();client.destroy();return;}
      for(;;){const i=incoming.indexOf('\n');if(i<0)break;const line=incoming.slice(0,i);incoming=incoming.slice(i+1);
        try{const message=JSON.parse(line);record('request',message);const reason=permit?.(message);
          if(reason){record('budget-denied',{id:message.id,reason});if(message.id!==undefined)client.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:reason}})+'\n');}
          else child?.stdin?.write(line+'\n');
        }catch{stop();client.destroy();return;}
      }
    });
    child.stdout!.on('data', traceLines('response'));child.stdout!.pipe(client);
    // Native provider stderr can include auth diagnostics; preserve no raw bytes.
    child.stderr!.on('data', chunk => record('stderr', { byteLength: chunk.length }));
    child.on('error', () => { record('transport-error', 'native server spawn failed'); client.destroy(); });
    child.on('exit', code => { record('native-exit', { code }); client.end(); });
    client.on('error', stop);
    client.on('close', stop);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  return { async close() {
    connection?.destroy();try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{child?.kill('SIGKILL');}
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (fs.existsSync(socket)) fs.unlinkSync(socket);
  } };
}

export async function connectSequenceTransport(socket: string) {
  const client = net.createConnection(socket);
  client.once('connect', () => { process.stdin.pipe(client); client.pipe(process.stdout); });
  client.on('error', () => { process.stderr.write('Native sequence transport unavailable\n'); process.exitCode = 1; });
  await new Promise<void>(resolve => client.once('close', () => { process.stdin.destroy(); resolve(); }));
}
