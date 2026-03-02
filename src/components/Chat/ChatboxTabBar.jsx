import React, { useState, useRef, useCallback, useEffect, useReducer } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { AiOutlineClose, AiOutlineDown } from 'react-icons/ai';

const ChatboxTabBar = ({ tabs, activeTabId, onTabClick, onCloseTab, onCloseAllTabs, onAddTab, onReorderTabs, compact = false }) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const groupRef = useRef(null);
  const tabRefsMap = useRef({});
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  // Chrome-style close animation refs
  const closingTabIds = useRef(new Set());
  const frozenWidths = useRef(new Map());
  const isAnimating = useRef(false);
  const expandTimerRef = useRef(null);
  const collapseTimers = useRef(new Map());

  // Latest callback refs for deferred timer calls
  const onCloseTabRef = useRef(onCloseTab);
  const onTabClickRef = useRef(onTabClick);
  onCloseTabRef.current = onCloseTab;
  onTabClickRef.current = onTabClick;

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
      collapseTimers.current.forEach(t => clearTimeout(t));
    };
  }, []);

  // Clean stale refs when tabs array changes
  useEffect(() => {
    const currentIds = new Set(tabs.map(t => t.id));
    for (const id of frozenWidths.current.keys()) {
      if (!currentIds.has(id)) frozenWidths.current.delete(id);
    }
    for (const id of closingTabIds.current) {
      if (!currentIds.has(id)) closingTabIds.current.delete(id);
    }
  }, [tabs]);

  const handleReorder = (newOrder) => {
    if (isAnimating.current) return;
    onReorderTabs?.(newOrder);
  };

  const handleChromeClose = useCallback((e, closedId) => {
    e.stopPropagation();

    // Only one visible tab → close immediately, no animation
    const visibleTabs = tabs.filter(t => !closingTabIds.current.has(t.id));
    if (visibleTabs.length <= 1) {
      onCloseTab(e, closedId);
      return;
    }

    // Switch active tab immediately if closing the active one
    if (closedId === activeTabId) {
      const closedIndex = tabs.findIndex(t => t.id === closedId);
      let neighbor = null;
      for (let i = closedIndex + 1; i < tabs.length; i++) {
        if (!closingTabIds.current.has(tabs[i].id)) { neighbor = tabs[i]; break; }
      }
      if (!neighbor) {
        for (let i = closedIndex - 1; i >= 0; i--) {
          if (!closingTabIds.current.has(tabs[i].id)) { neighbor = tabs[i]; break; }
        }
      }
      if (neighbor) onTabClickRef.current(neighbor.id);
    }

    // --- Phase 1: Freeze non-closing tabs at pixel widths (sync DOM) ---
    tabs.forEach(tab => {
      if (tab.id !== closedId && !closingTabIds.current.has(tab.id)) {
        const el = tabRefsMap.current[tab.id];
        if (el) {
          const w = el.getBoundingClientRect().width;
          frozenWidths.current.set(tab.id, w);
          el.style.width = w + 'px';
          el.style.flex = 'none';
          el.style.minWidth = '0';
          el.style.maxWidth = 'none';
          el.style.transition = 'none';
        }
      }
    });

    // Mark closing + freeze its width via DOM
    closingTabIds.current.add(closedId);
    isAnimating.current = true;
    const closingEl = tabRefsMap.current[closedId];
    const closingWidth = closingEl ? closingEl.getBoundingClientRect().width : 0;

    if (closingEl) {
      closingEl.style.width = closingWidth + 'px';
      closingEl.style.flex = 'none';
      closingEl.style.minWidth = '0';
      closingEl.style.maxWidth = 'none';
      closingEl.style.overflow = 'hidden';
      closingEl.style.padding = '0';
      closingEl.style.pointerEvents = 'none';
      closingEl.style.transition = 'none';
    }

    // Re-render: layout={false}, opacity 0 on closing tab
    forceUpdate();

    // --- Phase 2: Collapse closing tab width → 0 ---
    requestAnimationFrame(() => {
      const el = tabRefsMap.current[closedId];
      if (el) {
        el.style.transition = 'width 200ms ease';
        el.style.width = '0';
      }
    });

    // --- Phase 3: Remove tab after collapse, schedule expand ---
    const collapseTimer = setTimeout(() => {
      collapseTimers.current.delete(closedId);
      closingTabIds.current.delete(closedId);
      delete tabRefsMap.current[closedId];

      const fakeEvent = { stopPropagation: () => {} };
      onCloseTabRef.current(fakeEvent, closedId);

      // Reset expand timer (consecutive closes keep refreshing)
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
      expandTimerRef.current = setTimeout(() => {
        expandTimerRef.current = null;

        // Calculate target width for smooth expand
        const containerW = groupRef.current?.getBoundingClientRect().width || 0;
        const count = frozenWidths.current.size;
        if (count > 0) {
          const gaps = (count - 1) * 4;
          const targetW = Math.min(160, Math.max(60, (containerW - gaps) / count));
          frozenWidths.current.forEach((_, tabId) => {
            const el = tabRefsMap.current[tabId];
            if (el) {
              el.style.transition = 'width 250ms ease';
              el.style.width = targetW + 'px';
            }
          });
        }

        // Cleanup after expand completes
        setTimeout(() => {
          frozenWidths.current.clear();
          isAnimating.current = false;
          Object.values(tabRefsMap.current).forEach(el => {
            if (el) {
              el.style.transition = '';
              el.style.width = '';
              el.style.flex = '';
              el.style.minWidth = '';
              el.style.maxWidth = '';
            }
          });
          forceUpdate();
        }, 280);
      }, 300);
    }, 220);

    collapseTimers.current.set(closedId, collapseTimer);
  }, [tabs, activeTabId, onCloseTab]);

  return (
    <div 
      className={`draggable w-full h-full flex items-center px-1 gap-1 min-w-0 ${compact ? 'h-full' : 'h-8 mt-1'}`} 
      data-tauri-drag-region
    >
      <div ref={groupRef} className="flex-1 w-0 min-w-0 h-full">
        <Reorder.Group
          axis="x"
          values={tabs}
          onReorder={handleReorder}
          className="w-full h-full flex flex-nowrap overflow-x-auto scrollbar-thin gap-1 items-center mask-linear-fade"
          data-tauri-drag-region
        >
          {tabs.map((tab) => {
            const isClosing = closingTabIds.current.has(tab.id);
            return (
              <Reorder.Item
                key={tab.id}
                value={tab}
                ref={(el) => {
                  if (el) tabRefsMap.current[tab.id] = el;
                  else delete tabRefsMap.current[tab.id];
                }}
                layout={!isAnimating.current}
                dragListener={!isAnimating.current}
                initial={{ opacity: 0 }}
                animate={{ opacity: isClosing ? 0 : 1 }}
                transition={{
                  layout: { duration: 0.25, ease: "easeOut" },
                  opacity: { duration: isClosing ? 0 : 0.15 }
                }}
                whileDrag={{
                  scale: 1.05,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  zIndex: 50,
                  cursor: "grabbing"
                }}
                onClick={() => !isClosing && onTabClick(tab.id)}
                className={`no-drag group relative flex-1 min-w-[60px] max-w-[160px] flex items-center justify-between cursor-pointer text-[11px] px-3 py-1.5 rounded-full transition-colors duration-150 ${
                  tab.id === activeTabId
                    ? 'bg-white/70 text-gray-700 font-medium shadow-sm'
                    : 'bg-transparent text-gray-500 hover:bg-white/40'
                }`}
              >
                <span className="truncate flex-1 text-center pointer-events-none">{tab.label}</span>
                {!isClosing && (
                  <AiOutlineClose
                    onClick={(e) => handleChromeClose(e, tab.id)}
                    className={`ml-1 text-gray-400 hover:text-red-500 cursor-pointer pointer-events-auto ${
                      tab.id === activeTabId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    size={10}
                  />
                )}
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      </div>

      {/* Actions: Dropdown */}
      <div className="flex items-center gap-0.5 no-drag flex-shrink-0">
         <div className="relative">
            <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors"
            >
                <AiOutlineDown size={12} />
            </button>
            
            {/* Dropdown Menu */}
            <AnimatePresence>
                {showDropdown && (
                    <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
                    <motion.div
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 5 }}
                        className="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50 max-h-60 overflow-y-auto"
                    >
                        {tabs.map(tab => (
                            <div 
                                key={tab.id}
                                onClick={() => { onTabClick(tab.id); setShowDropdown(false); }}
                                className={`px-3 py-2 text-xs flex items-center justify-between hover:bg-gray-50 cursor-pointer ${
                                    tab.id === activeTabId ? 'text-blue-600 font-medium bg-blue-50' : 'text-gray-600'
                                }`}
                            >
                                <span className="truncate">{tab.label}</span>
                                <AiOutlineClose 
                                    onClick={(e) => { e.stopPropagation(); onCloseTab(e, tab.id); }}
                                    className="text-gray-400 hover:text-red-500"
                                />
                            </div>
                        ))}
                        {/* Close All Divider & Button */}
                        {tabs.length > 0 && (
                          <>
                            <div className="border-t border-gray-100 my-1" />
                            <div 
                                onClick={() => { onCloseAllTabs?.(); setShowDropdown(false); }}
                                className="px-3 py-2 text-xs text-red-500 hover:bg-red-50 cursor-pointer flex items-center gap-1"
                            >
                                <AiOutlineClose size={10} />
                                <span>Close All</span>
                            </div>
                          </>
                        )}
                    </motion.div>
                    </>
                )}
            </AnimatePresence>
         </div>
      </div>
    </div>
  );
};export default ChatboxTabBar;