/** Explicit transport for GBrain's trusted-local code readers; upstream code semantics stay unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
export const codeReadNames=['code_def','code_refs','code_callers','code_callees','code_blast','code_flow'];
const definitions={
 code_def:{symbol:z.string().min(1).max(512),limit:z.number().int().min(1).max(100).optional(),lang:z.string().min(1).max(64).optional()},
 code_refs:{symbol:z.string().min(1).max(512),limit:z.number().int().min(1).max(100).optional(),lang:z.string().min(1).max(64).optional()},
 code_callers:{symbol:z.string().min(1).max(512),limit:z.number().int().min(1).max(100).optional()},
 code_callees:{symbol:z.string().min(1).max(512),limit:z.number().int().min(1).max(100).optional()},
 code_blast:{symbol:z.string().min(1).max(512),depth:z.number().int().min(1).max(8).optional(),max_nodes:z.number().int().min(1).max(200).optional(),exact:z.boolean().optional()},
 code_flow:{entry_point:z.string().min(1).max(512),depth:z.number().int().min(1).max(12).optional(),max_nodes:z.number().int().min(1).max(200).optional(),exact:z.boolean().optional()},
};
export function codeRead(cfg,native,name,args){
 if(!codeReadNames.includes(name))throw Error('native code read operation not allowed');
 const parsed=z.object(definitions[name]).strict().parse(args);
 const home=path.join(cfg.root,'gbrain-home'),file=path.join(home,'.gbrain','config.json');
 if(fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==file)throw Error('native brain config must stay in the owned home');
 const current=JSON.parse(fs.readFileSync(file,'utf8'));
 if(current.engine!=='postgres'||!cfg.expected_database_url||current.database_url!==cfg.expected_database_url)throw Error('native brain database differs from controller binding');
 if(cfg.code_source_id!=='default')throw Error('native code source must be the owned default source');
 if(['code_callers','code_callees','code_blast','code_flow'].includes(name))parsed.source_id='default';
 return native.operation(name,parsed);
}
export function registerCodeReaders(server,cfg,native){
 for(const name of codeReadNames)server.registerTool('gbrain_'+name,{
  description:`Read the owned GBrain code graph using supported trusted-local ${name}. The upstream agent MCP code reader is suspended; this scoped transport calls the unchanged native CLI.`,
  inputSchema:definitions[name],
 },async args=>({content:[{type:'text',text:JSON.stringify(codeRead(cfg,native,name,args))}]}));
}
