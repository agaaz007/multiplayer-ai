#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {graphifyStore}=await import(pathToFileURL(path.join(cfg.runtime,'eval','analytical-graphify.js')).href);
const graph=graphifyStore({arm:'graphify',root:cfg.root,namespace:cfg.namespace,mode:'native',
 task:{provenance:{externalExportAllowed:true}},allowExternalExport:true,allowPaidOperations:true,
 graphify:{...cfg.graphify,maxOutputTokens:4096,maxRetries:0,apiTimeoutSeconds:120},
 trace:(operation,detail)=>fs.appendFileSync(cfg.trace_file,JSON.stringify({at:new Date().toISOString(),operation,detail})+'\n',{mode:0o600})});
const server=new McpServer({name:'teamwork-graphify',version:'2.0.0'});
const tool=(name,description,inputSchema,fn)=>server.registerTool(name,{description,inputSchema},async args=>({content:[{type:'text',text:JSON.stringify(await fn(args))}]}));
tool('graphify_write_source','Save original working evidence or notes to the private corpus.',{id:z.string().max(160),content:z.string().max(100000)},a=>graph.write(a.id,a.content));
tool('graphify_extract','Run official semantic extraction on the saved corpus; billed and budget-gated by controller.',{},()=>{graph.extract();return {extracted:true};});
tool('graphify_query','Query the official graph.',{query:z.string().max(2000),budget:z.number().int().min(100).max(10000).default(2000)},a=>graph.query(a.query,a.budget));
tool('graphify_list_sources','List saved original source files.',{},()=>graph.sources());
tool('graphify_read_source','Read one original saved source.',{id:z.string()},a=>graph.source(a.id));
tool('graphify_affected','Traverse reverse dependencies.',{node:z.string(),depth:z.number().int().min(1).max(10).default(3)},a=>graph.affected(a.node,a.depth));
tool('graphify_explain','Explain graph node evidence.',{node:z.string()},a=>graph.explain(a.node));
tool('graphify_path','Find graph path between nodes.',{from:z.string(),to:z.string()},a=>graph.shortestPath(a.from,a.to));
tool('graphify_save_result','Save useful, dead-end, or corrected feedback.',{question:z.string().max(4000),answer:z.string().max(100000),outcome:z.enum(['useful','dead_end','corrected']),correction:z.string().max(100000).optional(),nodes:z.array(z.string()).default([])},a=>graph.save(a));
tool('graphify_reflect','Run native reflection over saved feedback.',{},()=>graph.reflect());
await server.connect(new StdioServerTransport());
