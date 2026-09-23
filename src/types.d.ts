export {}
declare global {
  interface Window {
    studio: {
      getSettings(): Promise<{token:string;downloadDir:string;ragReady:boolean;trainingReady:boolean;convertReady:boolean;converter:{baseUrl:string;model:string;hasApiKey:boolean}}>; saveSettings(v:object):Promise<boolean>; listJobs():Promise<Array<any>>; listLocalModels():Promise<Array<{id:string;path:string}>>; saveConverterSettings(v:{baseUrl:string;model:string;apiKey?:string}):Promise<{baseUrl:string;model:string;hasApiKey:boolean}>; openConverterFile():Promise<string|null>; openConverterFolder():Promise<string|null>; convertDocument(v:{filePath:string;apiKey:string;shareWithProvider:boolean;outputMode?:'training'|'rag'}):Promise<{jobId:string;rows:Array<any>;chunks:number}>; saveConverterCsv(v:{rows:Array<any>;outputMode?:'training'|'rag'}):Promise<string|null>; onConverterProgress(cb:(v:{current:number;total:number;message:string})=>void):()=>void
      validateToken(token:string):Promise<{name?:string;fullname?:string}>; searchModels(v:{query:string;token:string}):Promise<Array<{id:string;downloads:number;likes:number;pipeline_tag?:string;private?:boolean}>>
      downloadModel(v:{repo:string;token:string;directory:string}):Promise<{path:string;files:number}>; setupWorker(options?:{gpu?:boolean;purpose?:'rag'|'training'|'convert'}):Promise<{ready:boolean;python:string}>; onDownloadProgress(cb:(v:{current:number;total:number;file:string})=>void):()=>void
      openDataFile():Promise<string|null>; openDataFolder():Promise<string|null>; readDataFile(file:string):Promise<{kind:'csv';text:string}|{kind:'xlsx';data:string}>; writeTemplate(v:any):Promise<string>; runJob(job:any):Promise<any>; onWorkerEvent(cb:(v:any)=>void):()=>void; onSetupProgress(cb:(v:{message:string})=>void):()=>void; saveTemplate(ext:string):Promise<{filePath?:string;canceled:boolean}>; chooseDownloadDir():Promise<string|null>; openPath(p:string):Promise<string>
    }
  }
}
