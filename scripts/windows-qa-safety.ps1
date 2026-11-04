# QA-only helpers. No process is adopted by name or PID; every job starts suspended.
if (!('SubtitleQaJob' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class SubtitleQaJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,cx,cy,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting data,uint length,IntPtr result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint time);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
 IntPtr job,process,thread;
 public uint Pid {get;private set;}
 public long StartUtcTicks {get;private set;}
 public string Name {get;private set;}
 public uint ExitCode { get { uint code;if(process==IntPtr.Zero || !GetExitCodeProcess(process,out code))throw new Win32Exception();return code; } }
 public uint Active { get { Accounting value;if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Win32Exception();return value.active; } }
 public static string Quote(string value) {
  var output=new StringBuilder("\""); int slashes=0;
  foreach(char ch in value){if(ch=='\\'){slashes++;continue;} if(ch=='\"'){output.Append('\\',slashes*2+1);output.Append(ch);}else{output.Append('\\',slashes);output.Append(ch);}slashes=0;}
  output.Append('\\',slashes*2);output.Append('"');return output.ToString();
 }
 public static string CommandLine(string exe,string[] args,bool nsis) {
  var command=new StringBuilder(Quote(exe));
  if(nsis){
   if(args.Length<1 || args.Length>2 || args[0]!="/S")throw new InvalidOperationException("Unexpected NSIS QA arguments.");
   command.Append(" /S");
   if(args.Length==2){var tail=args[1];if(!tail.StartsWith("/D=",StringComparison.Ordinal) || tail.IndexOfAny(new char[]{'"','\r','\n','\0'})>=0 || !System.IO.Path.IsPathRooted(tail.Substring(3)))throw new InvalidOperationException("Unsafe NSIS destination.");command.Append(' ').Append(tail);}
  }else foreach(var arg in args)command.Append(' ').Append(Quote(arg));
  return command.ToString();
 }
 public static SubtitleQaJob StartSuspended(string name,string exe,string[] args,string cwd) { return StartSuspended(name,exe,args,cwd,false); }
 public static SubtitleQaJob StartSuspended(string name,string exe,string[] args,string cwd,bool nsis) {
  var owner=new SubtitleQaJob();owner.Name=name;
  SetLastError(0);owner.job=CreateJobObject(IntPtr.Zero,name);
  if(owner.job==IntPtr.Zero)throw new Win32Exception();
  try {
   if(Marshal.GetLastWin32Error()==183)throw new InvalidOperationException("QA job name already exists.");
   var limit=new ExtendedLimit();limit.basic.flags=0x2000;
   if(!SetInformationJobObject(owner.job,9,ref limit,(uint)Marshal.SizeOf(typeof(ExtendedLimit))))throw new Win32Exception();
   var startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));startup.flags=1;startup.show=0;
   var command=new StringBuilder(CommandLine(exe,args,nsis));
   ProcessInfo info;
   if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x00000004|0x08000000,IntPtr.Zero,cwd,ref startup,out info))throw new Win32Exception();
   owner.process=info.process;owner.thread=info.thread;owner.Pid=info.pid;
   long creation,exit,kernel,user;
   if(!GetProcessTimes(owner.process,out creation,out exit,out kernel,out user))throw new Win32Exception();
   owner.StartUtcTicks=DateTime.FromFileTimeUtc(creation).Ticks;
   if(!AssignProcessToJobObject(owner.job,owner.process))throw new Win32Exception();
   return owner;
  } catch { if(owner.process!=IntPtr.Zero){TerminateProcess(owner.process,1);WaitForSingleObject(owner.process,5000);}owner.Dispose();throw; }
 }
 public static SubtitleQaJob OpenOwned(string name) {
  var handle=OpenJobObject(0x0004|0x0008,false,name);
  if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==2)return null;throw new Win32Exception();}
  var owner=new SubtitleQaJob();owner.job=handle;owner.Name=name;return owner;
 }
 public void Resume(){if(thread==IntPtr.Zero || ResumeThread(thread)==0xffffffff)throw new Win32Exception();CloseHandle(thread);thread=IntPtr.Zero;}
 public bool WaitEmpty(int timeout){var timer=System.Diagnostics.Stopwatch.StartNew();do{if(Active==0)return true;System.Threading.Thread.Sleep(20);}while(timer.ElapsedMilliseconds<timeout);return Active==0;}
 public bool StopAndWait(int timeout){if(Active==0)return true;if(!TerminateJobObject(job,1))return false;return WaitEmpty(timeout);}
 public void Dispose(){if(thread!=IntPtr.Zero){CloseHandle(thread);thread=IntPtr.Zero;}if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
}
public static class SubtitleQaPath {
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
 [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint attributes;public FileTime creation,access,write;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint sharing,IntPtr attributes,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static string FinalDirectory(string path){
  var handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  if(handle==new IntPtr(-1))throw new Win32Exception();
  try{
   FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception();
   if((info.attributes&0x10)==0 || (info.attributes&0x400)!=0)throw new InvalidOperationException("QA final directory handle was not a regular directory.");
   var output=new StringBuilder(512);uint length=GetFinalPathNameByHandle(handle,output,(uint)output.Capacity,0);
   if(length==0)throw new Win32Exception();
   if(length>=output.Capacity){output=new StringBuilder((int)length+1);length=GetFinalPathNameByHandle(handle,output,(uint)output.Capacity,0);if(length==0 || length>=output.Capacity)throw new Win32Exception();}
   var result=output.ToString();
   if(result.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))return "\\\\"+result.Substring(8);
   if(result.StartsWith("\\\\?\\",StringComparison.Ordinal))return result.Substring(4);
   throw new InvalidOperationException("QA directory final path was not a recognized filesystem path.");
  }finally{CloseHandle(handle);}
 }
}
'@
}

function Assert-QANoReparse([string] $Path) {
  $absolute=[IO.Path]::GetFullPath($Path)
  Assert-Condition ([IO.Path]::IsPathRooted($absolute)) 'QA path was not absolute.'
  $cursor=$absolute
  while ($cursor) {
    Assert-Condition ([IO.Directory]::Exists($cursor)) 'QA ancestry directory was missing.'
    $item=Get-Item -LiteralPath $cursor -Force
    Assert-Condition ($item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'QA ancestry contains a reparse point.'
    $parent=[IO.Directory]::GetParent($cursor); if (!$parent) { break }; $cursor=$parent.FullName
  }
  $absolute
}

function Assert-QAWorkspace([string] $Root,[string] $Target,[string] $Repository,[string] $Prefix='setup-acceptance-') {
  $repositoryFull=[SubtitleQaPath]::FinalDirectory((Assert-QANoReparse $Repository))
  $targetFull=[SubtitleQaPath]::FinalDirectory((Assert-QANoReparse $Target))
  $rootFull=[SubtitleQaPath]::FinalDirectory((Assert-QANoReparse $Root))
  Assert-Condition ([string]::Equals($repositoryFull,[IO.Path]::GetFullPath($Repository),[StringComparison]::OrdinalIgnoreCase)) 'QA repository final path changed from its approved absolute path.'
  Assert-Condition ($targetFull -eq [IO.Path]::GetFullPath((Join-Path $repositoryFull 'src-tauri\target'))) 'QA target did not match the repository.'
  Assert-Condition ([IO.Directory]::GetParent($rootFull).FullName -eq $targetFull -and [IO.Path]::GetFileName($rootFull) -match ('^'+[regex]::Escape($Prefix)+'[0-9a-f]{32}$')) 'QA workspace escaped its exact allowlist.'
  $rootFull
}

function Remove-QAWorkspace([string] $Root,[string] $Target,[string] $Repository,[string] $Prefix='setup-acceptance-') {
  $resolved=Assert-QAWorkspace $Root $Target $Repository $Prefix
  $dirs=[Collections.Generic.List[object]]::new();$files=[Collections.Generic.List[object]]::new();$pending=[Collections.Generic.Stack[string]]::new();$pending.Push($resolved)
  while($pending.Count) {
    [void](Assert-QAWorkspace $Root $Target $Repository $Prefix)
    $directory=$pending.Pop();[void](Assert-QANoReparse $directory)
    $items=@(Get-ChildItem -LiteralPath $directory -Force)
    $dirs.Add(@{path=$directory;names=@($items.Name|Sort-Object)})
    foreach($item in $items) {
      Assert-Condition ($item.FullName.StartsWith($resolved+'\',[StringComparison]::OrdinalIgnoreCase) -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Unexpected QA cleanup entry.'
      if($item.PSIsContainer){$pending.Push($item.FullName)}else{$files.Add(@{path=$item.FullName;length=$item.Length;modified=$item.LastWriteTimeUtc;created=$item.CreationTimeUtc})}
    }
  }
  # Validate the complete inventory before the first deletion, then recheck ancestry and
  # identity metadata before each operation. Unknown additions never get enumerated for deletion.
  foreach($dir in $dirs){[void](Assert-QANoReparse $dir.path);Assert-Condition ((@((Get-ChildItem -LiteralPath $dir.path -Force).Name|Sort-Object)-join "`0") -ceq ($dir.names-join "`0")) 'QA cleanup inventory changed.'}
  foreach($file in $files) {
    [void](Assert-QAWorkspace $Root $Target $Repository $Prefix);[void](Assert-QANoReparse ([IO.Path]::GetDirectoryName($file.path)))
    $current=Get-Item -LiteralPath $file.path -Force
    Assert-Condition (!$current.PSIsContainer -and !($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $current.Length -eq $file.length -and $current.LastWriteTimeUtc -eq $file.modified -and $current.CreationTimeUtc -eq $file.created) 'QA file changed after inventory.'
    Remove-Item -LiteralPath $file.path
  }
  foreach($dir in $dirs|Sort-Object {$_.path.Length} -Descending){[void](Assert-QAWorkspace $Root $Target $Repository $Prefix);[void](Assert-QANoReparse $dir.path);Assert-Condition (@(Get-ChildItem -LiteralPath $dir.path -Force).Count -eq 0) 'Unexpected data appeared during cleanup.';[IO.Directory]::Delete($dir.path,$false)}
}

function Assert-QAParentLease($Lease,[string] $Token,[string] $Exe,[string] $Profile,[string] $Target,[string] $Repository) {
  Assert-Condition ($Token -match '^[0-9a-f]{64}$' -and $Lease.producer -eq 'srttools-setup-lease-v1' -and $Lease.token -ceq $Token) 'Invalid setup delegation token.'
  [void](Assert-QAWorkspace $Lease.root $Target $Repository)
  Assert-Condition ($Lease.exe -eq [IO.Path]::GetFullPath($Exe) -and [IO.Path]::GetDirectoryName($Lease.exe) -eq (Join-Path $Lease.root 'installed') -and $Lease.backup -eq (Join-Path $Profile 'subtitle-tools-setup-qa-backup.json')) 'Delegated smoke paths did not match the owned setup.'
  $parent=Get-Process -Id $Lease.parentPid -ErrorAction Stop
  Assert-Condition ($parent.StartTime.ToUniversalTime().Ticks -eq [long]$Lease.parentStartUtcTicks) 'Delegating parent process was replaced.'
  $self=Get-Process -Id $PID
  Assert-Condition ($Lease.childPid -eq $PID -and $self.StartTime.ToUniversalTime().Ticks -eq [long]$Lease.childStartUtcTicks) 'Delegation was not issued to this exact child process.'
  $processInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
  Assert-Condition ($processInfo.ParentProcessId -eq $Lease.parentPid) 'Delegation parent was not the actual process parent.'
}

function Enter-QASmokeLease([string]$VerifiedParentToken,[scriptblock]$HasSetupBackup) {
  $guard=[Threading.Mutex]::new($false,'Local\SubtitleToolsReleaseSmoke');$owned=$false
  try{
    if($VerifiedParentToken){
      Assert-Condition ($VerifiedParentToken -match '^[0-9a-f]{64}$') 'Invalid delegated lease name.'
      $owned=$guard.WaitOne(0)
      Assert-Condition (!$owned -and (& $HasSetupBackup)) 'Setup parent did not retain its exclusive profile lease and backup.'
      $guard.Dispose();$guard=[Threading.Mutex]::new($false,('Local\SubtitleToolsSmokeDelegated-'+$VerifiedParentToken))
      $owned=$guard.WaitOne(0);Assert-Condition $owned 'Another delegated smoke is active.'
    }else{
      $owned=$guard.WaitOne(0);Assert-Condition $owned 'Another native QA profile lease is active.'
      Assert-Condition (!(& $HasSetupBackup)) 'An active or unrecovered setup backup prevents ordinary smoke.'
    }
    $guard
  }catch{if($owned){$guard.ReleaseMutex()};$guard.Dispose();throw}
}
