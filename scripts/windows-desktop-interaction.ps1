# Physical desktop checks target only the application and Explorer windows created by this QA run.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SubtitleDesktopInteraction {
 public delegate bool EnumChildProc(IntPtr handle, IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr handle, EnumChildProc callback, IntPtr parameter);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, System.Text.StringBuilder name, int max);
 [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
 [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
 [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
 [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
 [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int cx, int cy, uint flags);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumChildProc callback, IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
 [DllImport("user32.dll")] private static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetMenuString(IntPtr menu,uint item,System.Text.StringBuilder text,int max,uint flags);
 [DllImport("user32.dll")] private static extern bool GetMenuItemRect(IntPtr window,IntPtr menu,uint item,out Rect rect);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; public Point(int x,int y) { X=x;Y=y; } }
 public static IntPtr RootAt(int x,int y) { return GetAncestor(WindowFromPoint(new Point(x,y)),2); }
 public static bool ClickOwned(IntPtr owner,int x,int y) {
  if(GetForegroundWindow()!=owner || RootAt(x,y)!=owner) return false;
  var previous=System.Windows.Forms.Cursor.Position;
  try {
   if(!SetCursorPos(x,y)) return false;
   mouse_event(0x0002,0,0,0,UIntPtr.Zero);
   mouse_event(0x0004,0,0,0,UIntPtr.Zero);
   return true;
  } finally { SetCursorPos(previous.X,previous.Y); }
 }
 public static bool PressOwnedKey(IntPtr owner,byte key) {
  if(GetForegroundWindow()!=owner) return false;
  uint flags=key==0x24 || key==0x28 ? 1u : 0u;
  keybd_event(key,0,flags,UIntPtr.Zero);
  keybd_event(key,0,flags|2u,UIntPtr.Zero);
  return true;
 }
 public static IntPtr RootWindow(IntPtr handle) { return GetAncestor(handle,2); }
 public static string WindowClass(IntPtr handle) { var name=new System.Text.StringBuilder(128); GetClassName(handle,name,128); return name.ToString(); }
 public static void ContextMenu(IntPtr explorer) {
  IntPtr view=IntPtr.Zero;
  EnumChildWindows(explorer, delegate(IntPtr child,IntPtr parameter) {
   var name=new System.Text.StringBuilder(128); GetClassName(child,name,128);
   if(name.ToString()=="SHELLDLL_DefView") { view=child; return false; } return true;
  },IntPtr.Zero);
  if(view==IntPtr.Zero || !PostMessage(view,0x007B,view,new IntPtr(-1))) throw new InvalidOperationException("Owned Explorer view could not open its selection menu.");
 }
 public static void CancelMenu(IntPtr explorer) { PostMessage(explorer,0x001F,IntPtr.Zero,IntPtr.Zero); }
 public static void Topmost(IntPtr handle, bool top) { SetWindowPos(handle,new IntPtr(top ? -1 : -2),0,0,0,0,0x0013); }
 public static void RightClick(int x,int y) {
  var previous=System.Windows.Forms.Cursor.Position;
  try { SetCursorPos(x,y); mouse_event(0x0008,0,0,0,UIntPtr.Zero); mouse_event(0x0010,0,0,0,UIntPtr.Zero); }
  finally { SetCursorPos(previous.X,previous.Y); }
 }
 public static void LegacyRightClick(int x,int y) {
  keybd_event(0x10,0,0,UIntPtr.Zero);
  try { RightClick(x,y); } finally { keybd_event(0x10,0,2,UIntPtr.Zero); }
 }
 public static int PopupMenuCount() {
  int count=0;
  EnumWindows(delegate(IntPtr window,IntPtr parameter) { var name=new System.Text.StringBuilder(128);GetClassName(window,name,128);if(name.ToString()=="#32768" && IsWindowVisible(window))count++;return true; },IntPtr.Zero);
  return count;
 }
 public static string[] PopupTexts() {
  var texts=new System.Collections.Generic.List<string>();
  EnumWindows(delegate(IntPtr window,IntPtr parameter) { var name=new System.Text.StringBuilder(128);GetClassName(window,name,128);if(name.ToString()!="#32768" || !IsWindowVisible(window))return true;var menu=SendMessage(window,0x01E1,IntPtr.Zero,IntPtr.Zero);for(uint i=0;i<GetMenuItemCount(menu);i++){var text=new System.Text.StringBuilder(1024);GetMenuString(menu,i,text,1024,0x400);texts.Add(text.ToString());}return true;},IntPtr.Zero);
  return texts.ToArray();
 }
 public static bool ClickPopupItem(string needle) {
  IntPtr foundWindow=IntPtr.Zero; Rect found=new Rect();
  EnumWindows(delegate(IntPtr window,IntPtr parameter) {
   var name=new System.Text.StringBuilder(128);GetClassName(window,name,128);
   if(name.ToString()!="#32768" || !IsWindowVisible(window))return true;
   var menu=SendMessage(window,0x01E1,IntPtr.Zero,IntPtr.Zero);
   for(uint i=0;i<GetMenuItemCount(menu);i++) {
    var text=new System.Text.StringBuilder(1024);GetMenuString(menu,i,text,1024,0x400);
    if(text.ToString().Contains(needle) && GetMenuItemRect(IntPtr.Zero,menu,i,out found)){foundWindow=window;return false;}
   }return true;
  },IntPtr.Zero);
  if(foundWindow==IntPtr.Zero)return false;
  int x=(found.Left+found.Right)/2,y=(found.Top+found.Bottom)/2;
  if(RootAt(x,y)!=foundWindow)throw new InvalidOperationException("Owned shell menu item was covered.");
  var previous=System.Windows.Forms.Cursor.Position;
  try{SetCursorPos(x,y);mouse_event(0x0002,0,0,0,UIntPtr.Zero);mouse_event(0x0004,0,0,0,UIntPtr.Zero);}finally{SetCursorPos(previous.X,previous.Y);}
  return true;
 }
 public static void Drag(int x1,int y1,int x2,int y2) {
  var previous=System.Windows.Forms.Cursor.Position;
  try {
   SetCursorPos(x1,y1); mouse_event(0x0002,0,0,0,UIntPtr.Zero);
   for(int i=1;i<=30;i++) { SetCursorPos(x1+(x2-x1)*i/30,y1+(y2-y1)*i/30); System.Threading.Thread.Sleep(20); }
   System.Threading.Thread.Sleep(180);
  } finally { mouse_event(0x0004,0,0,0,UIntPtr.Zero); SetCursorPos(previous.X,previous.Y); }
 }
}
'@
