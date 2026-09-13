/** Lossless scoped filesystem transport; no generated summaries or retrieval logic. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function contained(root,relative,{exists=true}={}) {
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..'||x==='.git'||x==='.codex'||x==='.ledger'))throw new Error('invalid artifact-relative path');
 root=fs.realpathSync(root);const target=path.resolve(root,relative);if(!target.startsWith(root+path.sep))throw new Error('artifact escaped root');
 let current=root;for(const segment of path.relative(root,target).split(path.sep)){current=path.join(current,segment);let stat;try{stat=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat?.isSymbolicLink())throw new Error('artifact symlinks are not allowed');}
 if(exists&&!fs.statSync(target).isFile())throw new Error('artifact is not a regular file');return target;
}
export function inventory(root,{maxBytes=256*1024*1024,maxFileBytes=64*1024*1024}={}) {
 root=fs.realpathSync(root);const files=[];let bytes=0;
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.git','.codex','.ledger'].includes(entry.name))continue;
  const absolute=path.join(dir,entry.name),relative=path.relative(root,absolute).split(path.sep).join('/');
  if(entry.isSymbolicLink())throw new Error('unsupported symlink: '+relative);
  if(entry.isDirectory())walk(absolute);else if(entry.isFile()){
   const data=fs.readFileSync(absolute);bytes+=data.length;if(data.length>maxFileBytes||bytes>maxBytes)throw new Error('full artifact size limit exceeded; capture incomplete');
   files.push({path:relative,sha256:hash(data),bytes:data.length,mode:fs.statSync(absolute).mode&0o777});
  }else throw new Error('unsupported nonregular file: '+relative);
 }}walk(root);return {files,bytes,inventory_sha256:hash(JSON.stringify(files))};
}
export function restore(root,relative,bytes,{overwrite=false,sha256,mode=0o600}={}) {
 if(sha256&&hash(bytes)!==sha256)throw new Error('native artifact hash mismatch');
 const target=contained(root,relative,{exists:false});if(fs.existsSync(target)&&hash(fs.readFileSync(target))!==hash(bytes)&&!overwrite)throw new Error('destination differs; explicit overwrite required');
 fs.mkdirSync(path.dirname(target),{recursive:true});contained(root,relative,{exists:false});const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,mode);try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,mode);}finally{fs.closeSync(fd);}
 return {path:relative,bytes:bytes.length,sha256:hash(bytes)};
}
export function readRange(bytes,offset=0,length=65536){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>1024*1024)throw new Error('invalid read range');const part=bytes.subarray(offset,offset+length);return {offset,total_bytes:bytes.length,bytes:part.length,sha256:hash(bytes),encoding:'base64',content:part.toString('base64'),next_offset:offset+part.length<bytes.length?offset+part.length:null};}
