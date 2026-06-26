// frontend/src/components/ShieldsPanel.jsx
import { useState, useEffect, useRef, useCallback } from 'react'
// eslint-disable-next-line no-unused-vars
import { AnimatePresence, motion } from 'framer-motion'

/* ─────────────────────── Toggle Switch ─────────────────────── */

function ToggleSwitch({ checked, onChange, size = 'md' }) {
  const dims = size === 'sm'
    ? { track: 'w-8 h-[18px]', thumb: 'w-3.5 h-3.5', translate: checked ? 'translateX(14px)' : 'translateX(2px)' }
    : { track: 'w-11 h-6',    thumb: 'w-5 h-5',     translate: checked ? 'translateX(20px)' : 'translateX(2px)' }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`
        relative inline-flex shrink-0 cursor-pointer rounded-full
        transition-colors duration-300 ease-in-out
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]
        ${dims.track}
      `}
      style={{ backgroundColor: checked ? '#10b981' : '#d1d5db' }}
    >
      <span
        className={`
          pointer-events-none inline-block rounded-full bg-white shadow-lg
          ring-0 transition-transform duration-300 ease-[cubic-bezier(.4,0,.2,1)]
          ${dims.thumb}
        `}
        style={{
          transform: dims.translate,
          marginTop: size === 'sm' ? '2px' : '2px',
        }}
      />
    </button>
  )
}

/* ─────────────────── Shield SVG Icon ───────────────────────── */

function ShieldIcon({ active, className = '' }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      className={`transition-colors duration-300 ${className}`}
      fill={active ? '#10b981' : 'none'}
      stroke={active ? '#10b981' : '#9ca3af'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2L3.5 6.5V11c0 5.25 3.63 10.16 8.5 11.5 4.87-1.34 8.5-6.25 8.5-11.5V6.5L12 2z" />
      {active && (
        <path
          d="M9 12l2 2 4-4"
          fill="none"
          stroke="white"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

/* ────────────── Small shield for header ────────────────────── */

function ShieldIconSmall({ active }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={active ? '#10b981' : 'none'}
      stroke={active ? '#10b981' : '#9ca3af'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2L3.5 6.5V11c0 5.25 3.63 10.16 8.5 11.5 4.87-1.34 8.5-6.25 8.5-11.5V6.5L12 2z" />
    </svg>
  )
}

/* ─────────────────── Badge Counter ─────────────────────────── */

function BadgeCounter({ count }) {
  if (count <= 0) return null

  const display = count > 999 ? '999+' : String(count)

  return (
    <AnimatePresence mode="popLayout">
      <motion.span
        key={count}
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.5, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 25 }}
        className="
          absolute -top-1 -right-1
          flex items-center justify-center
          min-w-[16px] h-4 px-1
          rounded-full
          bg-[#ef4444] text-white
          text-[10px] font-bold leading-none
          pointer-events-none select-none
          shadow-sm
        "
      >
        {display}
      </motion.span>
    </AnimatePresence>
  )
}

/* ───────── Popover slide / fade animation config ───────────── */

const popoverVariants = {
  hidden: {
    opacity: 0,
    y: -8,
    scale: 0.96,
    transition: { duration: 0.15, ease: 'easeIn' },
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] },
  },
  exit: {
    opacity: 0,
    y: -6,
    scale: 0.97,
    transition: { duration: 0.15, ease: 'easeIn' },
  },
}

/* ═══════════════════ MAIN COMPONENT ════════════════════════ */

export function ShieldsPanel({ hostname, onReload }) {
  /* ── Early bail ─────────────────────────────────────────── */
  const blocking = typeof window !== 'undefined'
    ? window.superBrowserDesktop?.blocking
    : null

  const [open, setOpen] = useState(false)

  /* Stats */
  const [adsBlocked, setAdsBlocked] = useState(0)
  const [trackersBlocked, setTrackersBlocked] = useState(0)

  /* Settings */
  const [blockAds, setBlockAds] = useState(true)
  const [blockTrackers, setBlockTrackers] = useState(true)
  const [whitelist, setWhitelist] = useState([])

  const panelRef = useRef(null)
  const buttonRef = useRef(null)

  const isWhitelisted = hostname ? whitelist.includes(hostname) : false
  const shieldsActive = !isWhitelisted
  const totalBlocked = adsBlocked + trackersBlocked

  /* ── Fetch stats + settings ─────────────────────────────── */
  const fetchData = useCallback(async (ignore = false) => {
    if (!blocking || !hostname) return
    try {
      const [stats, settings] = await Promise.all([
        blocking.getStats(hostname),
        blocking.getSettings(),
      ])
      if (!ignore) {
        setAdsBlocked(stats?.adsBlocked ?? 0)
        setTrackersBlocked(stats?.trackersBlocked ?? 0)
        setBlockAds(settings?.blockAds ?? true)
        setBlockTrackers(settings?.blockTrackers ?? true)
        setWhitelist(settings?.blockingWhitelist ?? [])
      }
    } catch (err) {
      console.warn('[ShieldsPanel] Failed to fetch data:', err)
    }
  }, [blocking, hostname])

  useEffect(() => {
    let ignore = false
    const load = async () => {
      await fetchData(ignore)
    }
    load()
    return () => {
      ignore = true
    }
  }, [fetchData])

  /* ── Live stats subscription ────────────────────────────── */
  useEffect(() => {
    if (!blocking?.onStatsUpdate) return
    const cleanup = blocking.onStatsUpdate((stats) => {
      if (stats) {
        setAdsBlocked(stats.adsBlocked ?? 0)
        setTrackersBlocked(stats.trackersBlocked ?? 0)
      }
    })
    return cleanup
  }, [blocking])

  /* ── Click-outside to close ─────────────────────────────── */
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }
    // Escape key
    const handleEsc = (e) => { if (e.key === 'Escape') setOpen(false) }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  /* ── Handlers ───────────────────────────────────────────── */
  const handleMasterToggle = async () => {
    if (!blocking || !hostname) return
    try {
      // If currently whitelisted → enable shields (remove from whitelist)
      // If not whitelisted → disable shields (add to whitelist)
      await blocking.setDomainEnabled(hostname, isWhitelisted)
      await fetchData()
      onReload?.()
    } catch (err) {
      console.warn('[ShieldsPanel] setDomainEnabled failed:', err)
    }
  }

  const handleToggleAds = async () => {
    if (!blocking) return
    try {
      await blocking.toggle('ads')
      setBlockAds((v) => !v)
    } catch (err) {
      console.warn('[ShieldsPanel] toggle ads failed:', err)
    }
  }

  const handleToggleTrackers = async () => {
    if (!blocking) return
    try {
      await blocking.toggle('trackers')
      setBlockTrackers((v) => !v)
    } catch (err) {
      console.warn('[ShieldsPanel] toggle trackers failed:', err)
    }
  }

  /* ── Guard: nothing to render ───────────────────────────── */
  if (!blocking || !hostname) return null

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <div className="relative">
      {/* ── Shield Button ──────────────────────────────────── */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="
          relative p-1.5 rounded-full
          text-[var(--text-secondary)]
          hover:bg-[var(--bg-hover)]
          transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]
        "
        title={shieldsActive ? `Shields up for ${hostname}` : `Shields down for ${hostname}`}
        aria-label="Shields"
      >
        <ShieldIcon active={shieldsActive} />
        <BadgeCounter count={totalBlocked} />
      </button>

      {/* ── Popover Panel ──────────────────────────────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            variants={popoverVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="
              absolute top-full left-0 mt-2 z-50
              w-80
              bg-[var(--bg-elevated)]/95 backdrop-blur-xl
              border border-[var(--border-color)]
              rounded-xl shadow-2xl
              overflow-hidden
            "
            style={{ transformOrigin: 'top left' }}
          >
            {/* ── Header ──────────────────────────────────── */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-2">
              <ShieldIconSmall active={shieldsActive} />
              <h3 className="font-semibold text-sm text-[var(--text-primary)] truncate">
                Shields for{' '}
                <span className="text-[var(--accent)]">{hostname}</span>
              </h3>
            </div>

            {/* ── Stats Bar ───────────────────────────────── */}
            <div className="px-4 pb-3">
              <div
                className="
                  flex items-center gap-2 px-3 py-2
                  rounded-lg
                  bg-[var(--bg-hover)]/60
                  text-xs font-medium
                "
              >
                <span className="text-emerald-400 tabular-nums">
                  {adsBlocked}
                </span>
                <span className="text-[var(--text-tertiary)]">ads blocked</span>
                <span className="text-[var(--text-tertiary)] opacity-40">·</span>
                <span className="text-sky-400 tabular-nums">
                  {trackersBlocked}
                </span>
                <span className="text-[var(--text-tertiary)]">trackers blocked</span>
              </div>
            </div>

            {/* ── Master toggle ────────────────────────────── */}
            <div className="px-4 pb-3">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {shieldsActive ? 'Shields Up' : 'Shields Down'}
                  </span>
                  <span className="text-[11px] text-[var(--text-tertiary)] leading-tight">
                    Block ads & trackers on this site
                  </span>
                </div>
                <ToggleSwitch
                  checked={shieldsActive}
                  onChange={handleMasterToggle}
                  size="md"
                />
              </div>
            </div>

            {/* ── Separator ───────────────────────────────── */}
            <div className="mx-4 border-t border-[var(--border-color)]" />

            {/* ── Individual toggles ──────────────────────── */}
            <div className="px-4 py-3 space-y-2.5">
              {/* Ad Blocking */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] text-[var(--text-secondary)]">
                    Ad Blocking
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)] opacity-60">
                    (global)
                  </span>
                </div>
                <ToggleSwitch
                  checked={blockAds}
                  onChange={handleToggleAds}
                  size="sm"
                />
              </div>
              {/* Tracker Blocking */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] text-[var(--text-secondary)]">
                    Tracker Blocking
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)] opacity-60">
                    (global)
                  </span>
                </div>
                <ToggleSwitch
                  checked={blockTrackers}
                  onChange={handleToggleTrackers}
                  size="sm"
                />
              </div>
            </div>

            {/* ── Separator ───────────────────────────────── */}
            <div className="mx-4 border-t border-[var(--border-color)]" />

            {/* ── Footer ──────────────────────────────────── */}
            <div className="px-4 py-2.5">
              <p className="text-[11px] text-[var(--text-tertiary)] text-center select-none">
                Changes take effect after reload
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ShieldsPanel
