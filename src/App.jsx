import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Activity, Settings, Cpu, Zap, RefreshCw, Send, HardDrive } from 'lucide-react';

// --- Constants & FSM States ---
const STATE_DISABLE = 'DISABLE';
const STATE_ARMING = 'ARMING';
const STATE_MONITOR = 'MONITORING';
const STATE_FAULT = 'FAULT';

// Mặc định theo Spec
const DEFAULT_REGS = {
  CTRL: 0x00000000,
  tWD: 1600,       // ms
  tRST: 200,       // ms
  armDelay: 150,   // us (mô phỏng trên UI bằng ms để mắt người quan sát được)
  STATUS: 0x00000000
};

// UART Commands
const CMD_WRITE = 0x01;
const CMD_READ = 0x02;
const CMD_KICK = 0x03;
const CMD_STATUS = 0x04;

export default function WatchdogSimulator() {
  // --- Hardware State ---
  const [enSwitch, setEnSwitch] = useState(false); // S2 (Mô phỏng logic sau khi đảo từ Active-Low: 1 = Enable)
  const [wdiKick, setWdiKick] = useState(false);   // Cờ đánh dấu sườn xuống S1
  const [lastKickSrc, setLastKickSrc] = useState(0); // 0 = HW, 1 = SW
  
  // --- FSM & Timers ---
  const [fsmState, setFsmState] = useState(STATE_DISABLE);
  const [timerProgress, setTimerProgress] = useState(0);
  
  // --- Outputs ---
  const [enout, setEnout] = useState(false); // D4 (1 = System OK)
  const [wdo, setWdo] = useState(true);      // D3 (Active-Low: 1=OK, 0=Fault)
  
  // --- Register Map ---
  const [regs, setRegs] = useState(DEFAULT_REGS);
  
  // --- UART Console ---
  const [logs, setLogs] = useState([]);
  const logsEndRef = useRef(null);

  const [uartCmd, setUartCmd] = useState(CMD_WRITE);
  const [uartAddr, setUartAddr] = useState('0x04');
  const [uartData, setUartData] = useState('500');

  const addLog = (msg, type = 'info') => {
    const time = new Date().toISOString().split('T')[1].slice(0, 8) + '.' + new Date().getMilliseconds().toString().padStart(3, '0');
    setLogs(prev => [...prev, { time, msg, type }].slice(-100));
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // --- Cập nhật thanh ghi STATUS theo thời gian thực ---
  useEffect(() => {
    let statusVal = 0;
    if (fsmState !== STATE_DISABLE) statusVal |= (1 << 0); // bit0: EN_EFFECTIVE
    if (fsmState === STATE_FAULT) statusVal |= (1 << 1);   // bit1: FAULT_ACTIVE
    if (enout) statusVal |= (1 << 2);                      // bit2: ENOUT
    if (wdo) statusVal |= (1 << 3);                        // bit3: WDO (1=High, 0=Low)
    if (lastKickSrc === 1) statusVal |= (1 << 4);          // bit4: LAST_KICK_SRC

    setRegs(prev => ({ ...prev, STATUS: statusVal }));
  }, [fsmState, enout, wdo, lastKickSrc]);

  // --- HỆ THỐNG MÔ PHỎNG FSM (Tick mỗi 20ms) ---
  useEffect(() => {
    const TICK_MS = 20; // Chạy nhanh hơn để bắt kịp các giá trị timer nhỏ
    
    const interval = setInterval(() => {
      // Đọc các giá trị điều khiển
      const swEn = enSwitch || ((regs.CTRL & 0x01) !== 0); // EN từ S2 HOẶC từ bit0 thanh ghi CTRL
      const clrFault = (regs.CTRL & 0x04) !== 0;           // bit2 thanh ghi CTRL

      // 1. Kiểm tra EN = 0 (Disable)
      if (!swEn) {
        if (fsmState !== STATE_DISABLE) {
          setFsmState(STATE_DISABLE);
          setEnout(false);
          setWdo(true);
          setTimerProgress(0);
          addLog('[FSM] Watchdog Disabled (EN=0).', 'warn');
        }
        return;
      }

      // 2. Chuyển từ Disable -> Arming
      if (fsmState === STATE_DISABLE && swEn) {
        setFsmState(STATE_ARMING);
        setTimerProgress(0);
        addLog(`[FSM] Chuyển trạng thái ARMING (${regs.armDelay}ms)`, 'info');
        return;
      }

      // 3. Trạng thái ARMING
      if (fsmState === STATE_ARMING) {
        if (timerProgress >= regs.armDelay) {
          setFsmState(STATE_MONITOR);
          setEnout(true);
          setTimerProgress(0);
          addLog('[FSM] Hết arm_delay. Đã bật ENOUT. Bắt đầu giám sát.', 'success');
        } else {
          setTimerProgress(prev => prev + TICK_MS);
        }
        // Trong ARMING, mọi kick bị bỏ qua
        if (wdiKick) setWdiKick(false); 
      }

      // 4. Trạng thái MONITORING
      if (fsmState === STATE_MONITOR) {
        if (wdiKick) {
          setTimerProgress(0); // Reset timeout
          setWdiKick(false);   // Clear flag
          addLog(`[FSM] Nhận WDI Kick (Src: ${lastKickSrc === 0 ? 'S1 HW' : 'UART SW'}).`, 'success');
        } else if (timerProgress >= regs.tWD) {
          setFsmState(STATE_FAULT);
          setWdo(false); // WDO kéo thấp (Active-Low)
          setTimerProgress(0);
          addLog(`[TIMEOUT] Hết thời gian ${regs.tWD}ms! WDO kéo mức 0.`, 'error');
        } else {
          setTimerProgress(prev => Math.min(prev + TICK_MS, regs.tWD));
        }
      }

      // 5. Trạng thái FAULT
      if (fsmState === STATE_FAULT) {
        // Kiểm tra lệnh CLR_FAULT từ thanh ghi CTRL
        if (clrFault) {
          setRegs(prev => ({ ...prev, CTRL: prev.CTRL & ~0x04 })); // Tự động clear bit CLR_FAULT (write-1-to-clear)
          setFsmState(STATE_MONITOR);
          setWdo(true);
          setTimerProgress(0);
          addLog('[FSM] CLR_FAULT được kích hoạt. Nhả WDO ngay lập tức.', 'sys');
        } 
        // Đợi hết thời gian tRST
        else if (timerProgress >= regs.tRST) {
          setFsmState(STATE_MONITOR);
          setWdo(true);
          setTimerProgress(0);
          addLog(`[FSM] Hết thời gian giữ lỗi tRST (${regs.tRST}ms). Nhả WDO.`, 'info');
        } else {
          setTimerProgress(prev => Math.min(prev + TICK_MS, regs.tRST));
        }
        // Kick bị bỏ qua khi đang Fault
        if (wdiKick) setWdiKick(false);
      }

    }, TICK_MS);

    return () => clearInterval(interval);
  }, [enSwitch, fsmState, timerProgress, regs, wdiKick, lastKickSrc]);

  // --- Handlers ---
  const handleHWKick = () => {
    // 0x02 là bit 1: WDI_SRC (0 = HW, 1 = SW)
    if ((regs.CTRL & 0x02) !== 0) {
      addLog('[HW] S1 Kick bị bỏ qua do CTRL[1] (WDI_SRC) = 1.', 'warn');
      return;
    }
    setLastKickSrc(0); // 0 = HW S1
    setWdiKick(true);
  };

  const handleSWKick = () => {
    if ((regs.CTRL & 0x02) === 0) {
      addLog('[UART RX] NACK: KICK bị từ chối do CTRL[1] (WDI_SRC) = 0.', 'error');
      // Trả về ACK lỗi hoặc bỏ qua
      return;
    }
    setLastKickSrc(1); // 1 = SW UART
    setWdiKick(true);
  };

  // --- UART Frame Generator & Parser ---
  // Helper tính Checksum (XOR)
  const calcChecksum = (bytes) => bytes.reduce((acc, val) => acc ^ val, 0);
  
  // Helper chuyển số thành mảng byte (little endian, 32-bit hoặc 16-bit)
  const toBytes = (val, bytesLen = 4) => {
    const arr = [];
    for (let i = 0; i < bytesLen; i++) {
      arr.push((val >> (i * 8)) & 0xFF);
    }
    return arr;
  };

  const sendUARTFrame = (e) => {
    e.preventDefault();
    
    const cmd = parseInt(uartCmd);
    const addr = parseInt(uartAddr, 16);
    let dataVal = parseInt(uartData);
    if(isNaN(dataVal)) dataVal = 0;

    let payloadBytes = [];
    let len = 0;

    if (cmd === CMD_WRITE) {
      len = addr === 0x0C ? 2 : 4; // arm_delay là 16-bit, còn lại 32-bit
      payloadBytes = toBytes(dataVal, len);
    } else if (cmd === CMD_READ || cmd === CMD_STATUS || cmd === CMD_KICK) {
      len = 0; // Không có data gửi đi
    }

    const frameCore = [cmd, addr, len, ...payloadBytes];
    const chk = calcChecksum(frameCore);
    const fullFrame = [0x55, ...frameCore, chk];

    const hexString = fullFrame.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    addLog(`[UART TX] Frame: [ ${hexString} ]`, 'sys');

    // Xử lý Frame nhận được mô phỏng phần cứng xử lý
    setTimeout(() => {
      processUARTFrame(cmd, addr, dataVal);
    }, 50); // Mô phỏng trễ đường truyền
  };

  const processUARTFrame = (cmd, addr, dataVal) => {
    switch (cmd) {
      case CMD_WRITE:
        if (addr === 0x00) setRegs(p => ({ ...p, CTRL: dataVal }));
        else if (addr === 0x04) setRegs(p => ({ ...p, tWD: dataVal }));
        else if (addr === 0x08) setRegs(p => ({ ...p, tRST: dataVal }));
        else if (addr === 0x0C) setRegs(p => ({ ...p, armDelay: dataVal }));
        addLog(`[UART RX] ACK: Đã ghi thanh ghi 0x${addr.toString(16).padStart(2, '0').toUpperCase()} = ${dataVal}`, 'success');
        break;

      case CMD_READ:
        let val = 0;
        if (addr === 0x00) val = regs.CTRL;
        else if (addr === 0x04) val = regs.tWD;
        else if (addr === 0x08) val = regs.tRST;
        else if (addr === 0x0C) val = regs.armDelay;
        else if (addr === 0x10) val = regs.STATUS;
        
        // Trả về RESP
        const respData = toBytes(val, addr === 0x0C ? 2 : 4);
        const respFrame = [0x55, 0x00, addr, respData.length, ...respData]; // 0x00 mô phỏng RESP CMD
        respFrame.push(calcChecksum(respFrame.slice(1)));
        addLog(`[UART RX] RESP (0x${addr.toString(16).padStart(2, '0')}): Val = ${val} | Hex: [ ${respFrame.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')} ]`, 'success');
        break;

      case CMD_KICK:
        handleSWKick();
        addLog(`[UART RX] ACK: Đã thực thi SW KICK.`, 'success');
        break;

      case CMD_STATUS:
        // Trả nhanh thanh ghi 0x10
        addLog(`[UART RX] RESP STATUS: 0x${regs.STATUS.toString(16).padStart(8, '0').toUpperCase()}`, 'success');
        break;

      default:
        addLog(`[UART RX] NACK: Lệnh không hợp lệ (CMD=0x${cmd.toString(16)})`, 'error');
    }
  };

  // --- UI Helpers ---
  const getProgressWidth = () => {
    let max = 1;
    if (fsmState === STATE_ARMING) max = regs.armDelay;
    if (fsmState === STATE_MONITOR) max = regs.tWD;
    if (fsmState === STATE_FAULT) max = regs.tRST;
    return Math.min(100, (timerProgress / max) * 100) + '%';
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans p-4 lg:p-6 selection:bg-blue-500/30">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-xl gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-blue-500/20 p-3 rounded-lg border border-blue-500/30">
              <Cpu className="text-blue-400 w-8 h-8" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Watchdog Monitor RTL</h1>
              <p className="text-sm text-slate-400 font-medium">Nền tảng: Gowin GW1N-UV1P5 (Kiwi 1P5) • Mô phỏng TPS3431</p>
            </div>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="flex flex-col gap-1 w-full md:w-auto bg-slate-900/50 p-2 rounded-lg border border-slate-700">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider px-1">FSM Status</span>
              <div className={`px-4 py-1.5 rounded-md text-sm font-bold border text-center ${
                fsmState === STATE_MONITOR ? 'bg-green-500/20 text-green-400 border-green-500/40 shadow-[0_0_15px_rgba(34,197,94,0.2)]' :
                fsmState === STATE_FAULT ? 'bg-red-500/20 text-red-400 border-red-500/40 shadow-[0_0_15px_rgba(239,68,68,0.2)] animate-pulse' :
                fsmState === STATE_ARMING ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40' :
                'bg-slate-800 text-slate-400 border-slate-600'
              }`}>
                {fsmState}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LETA PANEL: BOARD MOCKUP */}
          <div className="lg:col-span-3 flex flex-col gap-6">
            <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl p-5">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <HardDrive className="w-4 h-4"/> Hardware GPIO
              </h2>
              
              <div className="border-2 border-slate-700 bg-[#0f172a] rounded-xl p-5 relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-slate-700 text-[10px] font-mono px-2 py-0.5 rounded-bl-lg text-slate-300">Board Kiwi 1P5</div>
                
                {/* BUTTONS */}
                <div className="space-y-4 mt-2">
                  <div className="group flex items-center justify-between bg-slate-800/80 hover:bg-slate-800 p-3 rounded-lg border border-slate-700 transition-colors">
                    <div>
                      <div className="font-bold text-slate-200">S2 (EN)</div>
                      <div className="text-[10px] text-slate-400 font-mono">Net: IOR1A</div>
                    </div>
                    <button 
                      onClick={() => setEnSwitch(!enSwitch)}
                      className={`relative w-12 h-6 rounded-full transition-colors duration-300 focus:outline-none ring-2 ring-offset-2 ring-offset-slate-800 ${enSwitch ? 'bg-blue-500 ring-blue-500/50' : 'bg-slate-600 ring-transparent'}`}
                    >
                      <div className={`absolute w-4 h-4 bg-white rounded-full top-1 transition-transform duration-300 shadow-sm ${enSwitch ? 'translate-x-7' : 'translate-x-1'}`}></div>
                    </button>
                  </div>

                  <div className="group flex items-center justify-between bg-slate-800/80 hover:bg-slate-800 p-3 rounded-lg border border-slate-700 transition-colors">
                    <div>
                      <div className="font-bold text-slate-200">S1 (WDI)</div>
                      <div className="text-[10px] text-slate-400 font-mono">Falling Edge</div>
                    </div>
                    <button 
                      onMouseDown={handleHWKick}
                      className="bg-gradient-to-b from-slate-600 to-slate-700 hover:from-slate-500 hover:to-slate-600 active:from-slate-700 active:to-slate-800 text-white p-2 rounded-lg shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)] border border-slate-900 focus:outline-none transition-all active:scale-95"
                    >
                      <Zap className={`w-5 h-5 ${fsmState === STATE_MONITOR ? 'text-yellow-400 drop-shadow-[0_0_5px_rgba(250,204,21,0.5)]' : 'text-slate-400'}`} />
                    </button>
                  </div>
                </div>

                <div className="w-full h-px bg-gradient-to-r from-transparent via-slate-600 to-transparent my-5"></div>

                {/* LEDs */}
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className={`absolute inset-0 rounded-full blur-sm transition-opacity duration-300 ${enout ? 'bg-green-500 opacity-70' : 'opacity-0'}`}></div>
                      <div className={`relative w-5 h-5 rounded-full border transition-colors duration-300 ${
                        enout ? 'bg-green-500 border-green-400' : 'bg-slate-800 border-slate-600 shadow-inner'
                      }`}></div>
                    </div>
                    <div>
                      <div className="font-bold text-slate-200 text-sm">LED D4 (ENOUT)</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className={`absolute inset-0 rounded-full blur-sm transition-opacity duration-300 ${!wdo ? 'bg-red-500 opacity-70' : 'opacity-0'}`}></div>
                      <div className={`relative w-5 h-5 rounded-full border transition-colors duration-300 ${
                        !wdo ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-600 shadow-inner'
                      }`}></div>
                    </div>
                    <div>
                      <div className="font-bold text-slate-200 text-sm">LED D3 (WDO)</div>
                      <div className="text-[10px] text-slate-400 font-mono">Active Low</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* MIDDLE PANEL: FSM & REGISTERS */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            
            {/* TIMING CHART */}
            <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl p-5">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4"/> FSM Real-time Engine
              </h2>
              
              <div className="bg-slate-900 rounded-xl p-5 font-mono text-sm border border-slate-700/50">
                <div className="flex justify-between text-slate-400 mb-3 text-xs">
                  <span className="font-semibold text-slate-300">TIMER: {timerProgress} ms</span>
                  <span>
                    MAX: {fsmState === STATE_MONITOR ? regs.tWD : fsmState === STATE_FAULT ? regs.tRST : fsmState === STATE_ARMING ? regs.armDelay : 0} ms
                  </span>
                </div>
                
                {/* Progress Bar */}
                <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden shadow-inner">
                  <div 
                    className={`h-full transition-all duration-75 ease-linear ${
                      fsmState === STATE_MONITOR ? 'bg-blue-500' :
                      fsmState === STATE_FAULT ? 'bg-red-500' :
                      fsmState === STATE_ARMING ? 'bg-yellow-500' : 'bg-transparent'
                    }`}
                    style={{ width: getProgressWidth() }}
                  ></div>
                </div>
                
                <div className="mt-5 grid grid-cols-4 gap-3 text-center text-xs">
                  <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700/50">
                    <span className="block text-slate-500 mb-1">WDI</span>
                    <span className="font-bold text-white">{wdiKick ? '↓ FALL' : 'HIGH'}</span>
                  </div>
                  <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700/50">
                    <span className="block text-slate-500 mb-1">EN</span>
                    <span className="font-bold text-white">{enSwitch ? '1' : '0'}</span>
                  </div>
                  <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700/50">
                    <span className="block text-slate-500 mb-1">WDO</span>
                    <span className={`font-bold ${wdo ? 'text-green-400' : 'text-red-400 animate-pulse'}`}>{wdo ? '1 (Hi-Z)' : '0 (FLT)'}</span>
                  </div>
                  <div className="bg-slate-800/80 p-2 rounded-lg border border-slate-700/50">
                    <span className="block text-slate-500 mb-1">ENOUT</span>
                    <span className={`font-bold ${enout ? 'text-green-400' : 'text-slate-600'}`}>{enout ? '1' : '0'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* REGISTER MAP */}
            <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl p-4">
               <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Settings className="w-4 h-4"/> Register Map
              </h2>
              <div className="overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-3 py-2 border-b border-slate-700">Addr</th>
                      <th className="px-3 py-2 border-b border-slate-700">Name</th>
                      <th className="px-3 py-2 border-b border-slate-700">Value (Dec)</th>
                      <th className="px-3 py-2 border-b border-slate-700">Value (Hex)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-800/50">
                    <tr className="hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-blue-400">0x00</td>
                      <td className="px-3 py-2 text-slate-200">CTRL</td>
                      <td className="px-3 py-2 text-slate-300">{regs.CTRL}</td>
                      <td className="px-3 py-2 text-slate-400">0x{regs.CTRL.toString(16).padStart(8, '0').toUpperCase()}</td>
                    </tr>
                    <tr className="hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-blue-400">0x04</td>
                      <td className="px-3 py-2 text-slate-200">tWD_ms</td>
                      <td className="px-3 py-2 text-slate-300">{regs.tWD}</td>
                      <td className="px-3 py-2 text-slate-400">0x{regs.tWD.toString(16).padStart(8, '0').toUpperCase()}</td>
                    </tr>
                    <tr className="hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-blue-400">0x08</td>
                      <td className="px-3 py-2 text-slate-200">tRST_ms</td>
                      <td className="px-3 py-2 text-slate-300">{regs.tRST}</td>
                      <td className="px-3 py-2 text-slate-400">0x{regs.tRST.toString(16).padStart(8, '0').toUpperCase()}</td>
                    </tr>
                    <tr className="hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-blue-400">0x0C</td>
                      <td className="px-3 py-2 text-slate-200">arm_delay_us</td>
                      <td className="px-3 py-2 text-slate-300">{regs.armDelay}</td>
                      <td className="px-3 py-2 text-slate-400">0x{regs.armDelay.toString(16).padStart(4, '0').toUpperCase()}</td>
                    </tr>
                    <tr className="hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-blue-400">0x10</td>
                      <td className="px-3 py-2 text-slate-200">STATUS</td>
                      <td className="px-3 py-2 text-slate-300">-</td>
                      <td className="px-3 py-2 font-bold text-yellow-400">0x{regs.STATUS.toString(16).padStart(8, '0').toUpperCase()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          {/* RIGHT PANEL: UART CONSOLE */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            
            {/* Frame Builder */}
            <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl p-5">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Send className="w-4 h-4"/> UART 9600 8N1 Builder
              </h2>
              <form onSubmit={sendUARTFrame} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">CMD (Hex)</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono"
                      value={uartCmd} onChange={(e) => setUartCmd(e.target.value)}
                    >
                      <option value={CMD_WRITE}>0x01 (WRITE)</option>
                      <option value={CMD_READ}>0x02 (READ)</option>
                      <option value={CMD_KICK}>0x03 (KICK)</option>
                      <option value={CMD_STATUS}>0x04 (STATUS)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">ADDR (Hex)</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono disabled:opacity-50"
                      value={uartAddr} onChange={(e) => setUartAddr(e.target.value)}
                      disabled={uartCmd === CMD_KICK || uartCmd === CMD_STATUS}
                    >
                      <option value="0x00">0x00 (CTRL)</option>
                      <option value="0x04">0x04 (tWD)</option>
                      <option value="0x08">0x08 (tRST)</option>
                      <option value="0x0C">0x0C (armDelay)</option>
                      {parseInt(uartCmd) === CMD_READ && <option value="0x10">0x10 (STATUS)</option>}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">DATA (Dec)</label>
                  <input 
                    type="number" 
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono disabled:opacity-50" 
                    value={uartData} onChange={(e) => setUartData(e.target.value)}
                    disabled={parseInt(uartCmd) !== CMD_WRITE}
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 px-4 rounded-lg text-sm font-semibold transition-colors shadow-lg shadow-blue-500/20">
                    Send Frame
                  </button>
                  {/* Shortcut Button */}
                  <button 
                    type="button" 
                    onClick={() => {
                       // Quick trigger CLR_FAULT
                       processUARTFrame(CMD_WRITE, 0x00, 0x04);
                    }} 
                    className="bg-slate-700 hover:bg-slate-600 text-slate-200 py-2 px-4 rounded-lg text-sm font-semibold transition-colors border border-slate-600"
                    title="Write 1 to CTRL[2]"
                  >
                    CLR_FAULT
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 italic mt-2">* Định dạng: [0x55] [CMD] [ADDR] [LEN] [DATA...] [CHK]</p>
              </form>
            </div>

            {/* Terminal Logs */}
            <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl flex flex-col overflow-hidden h-[250px] lg:h-[350px]">
              <div className="p-3 bg-slate-800/80 border-b border-slate-700 flex justify-between items-center">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <Terminal className="w-4 h-4"/> Console
                </h2>
                <button onClick={() => setLogs([])} className="text-xs text-slate-500 hover:text-slate-300">Clear</button>
              </div>
              <div className="flex-1 bg-[#0a0a0a] p-4 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {logs.length === 0 ? (
                  <span className="text-slate-600 italic">Hệ thống sẵn sàng. Bật công tắc S2 để bắt đầu...</span>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className={`mb-1.5 ${
                      log.type === 'error' ? 'text-red-400' :
                      log.type === 'success' ? 'text-green-400' :
                      log.type === 'warn' ? 'text-yellow-400' :
                      log.type === 'sys' ? 'text-blue-300' : 'text-slate-300'
                    }`}>
                      <span className="text-slate-600 select-none">[{log.time}]</span> {log.msg}
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}