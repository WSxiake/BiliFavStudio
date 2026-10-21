// Isolated API fixture. No account login, remote request or user data is used.
const folders = [{media_id:9527,title:'Fixture folder',count:6}];
const items = Array.from({length:6},(_,i)=>({key:`${i+1}:2`,avid:i+1,type:2,title:`Fixture ${i+1}`,upper:'Fixture UP',duration:60}));
const prefs = {ui:{},shortcuts:{},folder_order:null};
window.fetch = async (url,opts={}) => {
  const route=new URL(url,location.href).pathname;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(!route.startsWith('/api/')) throw Error('Unexpected fixture request: '+route);
  if(route==='/api/account') return json({ok:true,is_login:true,uname:'Fixture account',mid:1,face:''});
  if(route==='/api/health') return json({ok:true,state_dir:'fixture-data'});
  if(route==='/api/folders/mine') return json({ok:true,folders});
  if(route==='/api/folder/items') return json({ok:true,folder:folders[0],items});
  if(route==='/api/folder/resolve') return json({ok:true,folder:folders[0],preview:items});
  if(route==='/api/folder/cache') return json({ok:true,hit:false});
  if(route==='/api/prefs') return json({ok:true,prefs});
  if(route==='/api/prefs/ui-patch') {Object.assign(prefs.ui,JSON.parse(opts.body).ui);return json({ok:true});}
  if(route==='/api/prefs/set') {Object.assign(prefs,JSON.parse(opts.body));return json({ok:true});}
  if(route==='/api/task/status') return json({ok:true,state:'idle',busy:false,kind:'',seq:0,events:[],extra:{},result:null});
  if(route==='/api/tasks') return json({ok:true,tasks:[]});
  if(route==='/api/commits') return json({ok:true,commits:[]});
  if(route==='/api/draft/load') return json({ok:true,draft:null});
  if(route==='/api/system/theme') return json({ok:true,color:'#566CAE'});
  if(route==='/api/login/qr') return json({ok:true,svg:'',key:'fixture'});
  if(route==='/api/login/qr/poll') return json({ok:true,state:'waiting'});
  return json({ok:true});
};
