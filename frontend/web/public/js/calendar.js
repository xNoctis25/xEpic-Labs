document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token');
    if (!token || token === 'null' || token === 'undefined') {
        window.location.href = '/index.html';
        return;
    }

    const API_HEADERS = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    // ── Validate session is still alive before rendering ─────────
    try {
        const sessionCheck = await fetch('/api/auth/me', { headers: API_HEADERS });
        if (sessionCheck.status === 401) {
            localStorage.removeItem('jwt_token');
            sessionStorage.removeItem('jwt_token');
            window.location.href = '/index.html';
            return;
        }
    } catch (_) { /* network issue — allow page to continue */ }

    let currentDate = new Date();
    let events = [];

    // DOM Elements
    const grid      = document.getElementById('fullCalendarGrid');
    const todayBtn  = document.getElementById('calTodayFullBtn');
    

    // Mappings — 4 active categories in display order
    const CATEGORY_MAP = {
        'holiday':  { color: '#aa00ff', emoji: '🎆', label: 'Holiday'  },
        'birthday': { color: '#00e5ff', emoji: '🎂', label: 'Birthday' },
        'income':   { color: '#39ff14', emoji: '💵', label: 'Income'   },
        'expense':  { color: '#1de9b6', emoji: '💳', label: 'Expense'  }
    };

    // Active filter — 'all' or a category key
    let activeFilter = 'all';

    // ── DATA FETCHING ─────────────────────────────────────────
    async function loadAllEvents() {
        try {
            // Fetch Custom Events
            const customRes = await fetch('/api/auth/trading/custom-events', { headers: API_HEADERS });
            if (customRes.status === 401) {
                localStorage.removeItem('jwt_token');
                sessionStorage.removeItem('jwt_token');
                window.location.href = '/index.html';
                return;
            }
            const customData = customRes.ok ? await customRes.json() : [];

            const parsedCustom = customData.map(e => ({
                id: e.id,
                title: e.title,
                date: new Date(e.event_date),
                type: e.event_type,
                isCustom: true
            }));



            // Hardcoded Holidays 2026 (Copied from dashboard)
            const holidays2026 = [
                { title: 'New Year\'s Day 🎆', date: new Date('2026-01-01T00:00:00'), type: 'holiday' },
                { title: 'Martin Luther King Jr. Day ☮️', date: new Date('2026-01-19T00:00:00'), type: 'holiday' },
                { title: 'Presidents\' Day 🏛️', date: new Date('2026-02-16T00:00:00'), type: 'holiday' },
                { title: 'Good Friday 🕊️', date: new Date('2026-04-03T00:00:00'), type: 'holiday' },
                { title: 'Memorial Day 🪖', date: new Date('2026-05-25T00:00:00'), type: 'holiday' },
                { title: 'Juneteenth ✊🏿', date: new Date('2026-06-19T00:00:00'), type: 'holiday' },
                { title: 'Independence Day 🇺🇸', date: new Date('2026-07-03T00:00:00'), type: 'holiday' }, // Observed Friday
                { title: 'Labor Day 🛠️', date: new Date('2026-09-07T00:00:00'), type: 'holiday' },
                { title: 'Thanksgiving Day 🦃', date: new Date('2026-11-26T00:00:00'), type: 'holiday' },
                { title: 'Christmas Day 🎄', date: new Date('2026-12-25T00:00:00'), type: 'holiday' }
            ];

            events = [...parsedCustom, ...holidays2026];
            renderCalendar();
        } catch (err) {
            console.error('Failed to load events:', err);
        }
    }

    // ── RENDERING ─────────────────────────────────────────────
    function renderCalendar() {
        grid.innerHTML = '';
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        // Trigger shows full name, grid items use short names
        const SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const trigger = document.getElementById('mainCalTrigger');
        if (trigger) trigger.textContent = `${months[month]} ${year}`;

        const firstDayIndex = new Date(year, month, 1).getDay();
        const lastDate = new Date(year, month + 1, 0).getDate();
        const prevLastDate = new Date(year, month, 0).getDate();
        const totalCells = Math.ceil((firstDayIndex + lastDate) / 7) * 7;

        for (let i = 0; i < totalCells; i++) {
            const cell = document.createElement('div');
            cell.className = 'full-calendar-day';

            let cellDate;
            let dayNum;

            if (i < firstDayIndex) {
                // Prev month
                dayNum = prevLastDate - firstDayIndex + i + 1;
                cellDate = new Date(year, month - 1, dayNum);
                cell.classList.add('muted');
            } else if (i >= firstDayIndex + lastDate) {
                // Next month
                dayNum = i - firstDayIndex - lastDate + 1;
                cellDate = new Date(year, month + 1, dayNum);
                cell.classList.add('muted');
            } else {
                // Current month
                dayNum = i - firstDayIndex + 1;
                cellDate = new Date(year, month, dayNum);
                
                const today = new Date();
                if (dayNum === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                    cell.classList.add('today');
                }
            }

            // Number element
            const dateSpan = document.createElement('span');
            dateSpan.className = 'day-number';
            dateSpan.textContent = dayNum;
            cell.appendChild(dateSpan);

            // Filter events for this day
            const dayEvents = events.filter(e => 
                e.date.getDate() === cellDate.getDate() &&
                e.date.getMonth() === cellDate.getMonth() &&
                e.date.getFullYear() === cellDate.getFullYear()
            );

            // Sort events
            dayEvents.sort((a, b) => {
                const getWeight = (type) => {
                    return 1;
                };
                return getWeight(b.type) - getWeight(a.type);
            });

            const eventsContainer = document.createElement('div');
            eventsContainer.className = 'day-events';

            // Filter events by activeFilter before rendering
            const visibleEvents = activeFilter === 'all'
                ? dayEvents
                : dayEvents.filter(e => e.type === activeFilter);

            visibleEvents.forEach(e => {
                const pill = document.createElement('div');
                pill.className = `event-pill type-${e.type}`;
                
                const conf = CATEGORY_MAP[e.type] || CATEGORY_MAP['personal'];
                pill.style.borderLeft = `3px solid ${conf.color}`;
                
                // Add title
                // Add title
                let displayTitle = e.title;
                if (e.isCustom && conf.emoji) {
                    displayTitle = `${conf.emoji} ${e.title}`;
                }

                pill.innerHTML = `<span>${displayTitle}</span>`;


                eventsContainer.appendChild(pill);
            });

            cell.appendChild(eventsContainer);

            // Click → open day detail modal (use unfiltered dayEvents)
            cell.style.cursor = 'pointer';
            cell.addEventListener('click', () => openDayModal(cellDate, dayEvents));

            grid.appendChild(cell);
        }
    }

    // ── NAVIGATION ─────────────────────────────────────────────
    if(todayBtn) {
        todayBtn.addEventListener('click', () => {
            currentDate = new Date();
            renderCalendar();
        });
    }

    // ── FILTER BUTTONS (toggle: click active = deselect = show all) ──────
    document.querySelectorAll('.cal-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isActive = btn.classList.contains('active');
            document.querySelectorAll('.cal-filter-btn').forEach(b => b.classList.remove('active'));
            if (!isActive) {
                btn.classList.add('active');
                activeFilter = btn.dataset.filter;
            } else {
                activeFilter = 'all'; // deselect → show everything
            }
            renderCalendar();
        });
    });

    // ── UNIFIED MONTH/YEAR PICKER ─────────────────────────────
    const mainCalTrigger        = document.getElementById('mainCalTrigger');
    const mainCalOverlay        = document.getElementById('mainCalOverlay');
    const mainCalOverlayHeader  = document.getElementById('mainCalOverlayHeader');
    const mainCalMonthGrid      = document.getElementById('mainCalMonthGrid');
    const mainCalYearGrid       = document.getElementById('mainCalYearGrid');
    const mainCalTodayBtn       = document.getElementById('mainCalTodayBtn');

    const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let pickerYear = currentDate.getFullYear();
    let pickerMode = 'closed'; // 'closed' | 'months' | 'years'

    function renderPicker() {
        // Always show Today button when overlay is open (mirrors widget renderOverlay behavior)
        if (mainCalTodayBtn) mainCalTodayBtn.classList.remove('hidden');

        if (pickerMode === 'months') {
            mainCalYearGrid.classList.add('hidden');
            mainCalMonthGrid.classList.remove('hidden');
            mainCalOverlayHeader.textContent = pickerYear;  // shows the year number
            mainCalMonthGrid.innerHTML = '';
            SHORT_MONTHS.forEach((m, i) => {
                const btn = document.createElement('button');
                btn.className = 'main-cal-btn';
                if (pickerYear === currentDate.getFullYear() && i === currentDate.getMonth()) btn.classList.add('selected');
                btn.textContent = m;
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    currentDate.setFullYear(pickerYear, i, 1);
                    renderCalendar();
                    closePicker();
                });
                mainCalMonthGrid.appendChild(btn);
            });
        } else if (pickerMode === 'years') {
            mainCalMonthGrid.classList.add('hidden');
            mainCalYearGrid.classList.remove('hidden');
            mainCalOverlayHeader.textContent = 'Year';  // label only, not a back button
            const decadeStart = Math.floor(pickerYear / 10) * 10;
            mainCalYearGrid.innerHTML = '';
            for (let i = 0; i < 12; i++) {
                const y = decadeStart + i;
                const btn = document.createElement('button');
                btn.className = 'main-cal-btn';
                if (y === currentDate.getFullYear()) btn.classList.add('selected');
                btn.textContent = y;
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    pickerYear = y;
                    pickerMode = 'months';
                    renderPicker();
                });
                mainCalYearGrid.appendChild(btn);
            }
        }
    }

    function closePicker() {
        pickerMode = 'closed';
        if (mainCalOverlay) mainCalOverlay.classList.remove('active');
    }

    if (mainCalTrigger) {
        mainCalTrigger.addEventListener('click', e => {
            e.stopPropagation();
            if (pickerMode === 'closed') {
                pickerMode = 'months';
                pickerYear = currentDate.getFullYear();
                renderPicker();
                mainCalOverlay.classList.add('active');
            } else {
                closePicker();
            }
        });
    }

    if (mainCalOverlayHeader) {
        // Only months mode header is clickable (switches to year grid)
        // In years mode the header is just the 'Year' label — no action
        mainCalOverlayHeader.addEventListener('click', e => {
            e.stopPropagation();
            if (pickerMode === 'months') {
                pickerMode = 'years';
                renderPicker();
            }
        });
    }

    if (mainCalTodayBtn) {
        mainCalTodayBtn.addEventListener('click', e => {
            e.stopPropagation();
            currentDate = new Date();
            renderCalendar();
            closePicker();
        });
    }
    document.addEventListener('click', e => {
        if (pickerMode !== 'closed' && mainCalOverlay && !mainCalOverlay.contains(e.target) && e.target !== mainCalTrigger) {
            closePicker();
        }
    });

    // ── LIVE MARKET SESSION STATUS ────────────────────────────
    function updateMarketClock() {
        const uiSessionLabel = document.getElementById('uiSessionLabel');
        const uiSessionDot   = document.getElementById('uiSessionDot');
        if (!uiSessionLabel || !uiSessionDot) return;

        const nowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const now    = new Date(nowStr);
        const yyyy   = now.getFullYear();
        const mm     = String(now.getMonth() + 1).padStart(2, '0');
        const dd     = String(now.getDate()).padStart(2, '0');
        const dateStr      = `${yyyy}-${mm}-${dd}`;
        const day          = now.getDay();
        const totalMinutes = now.getHours() * 60 + now.getMinutes();

        // NYSE Holiday Calendar 2026-2027
        const nyseHolidays = [
            '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
            '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
            '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
            '2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'
        ];
        if (nyseHolidays.includes(dateStr)) {
            uiSessionLabel.textContent = 'Closed: Holiday';
            uiSessionDot.className     = 'dot red';
            return;
        }

        // Weekend gate
        if (day === 0 || day === 6) {
            uiSessionLabel.textContent = 'Closed: Weekend';
            uiSessionDot.className     = 'dot red';
            return;
        }

        // Outside equities hours (09:30 – 16:00 ET)
        if (totalMinutes < 570 || totalMinutes >= 960) {
            uiSessionLabel.textContent = 'Session: Closed';
            uiSessionDot.className     = 'dot red';
            return;
        }

        // ICT Session Phases
        let sessionText = '';
        let dotClass    = '';
        if      (totalMinutes >= 570 && totalMinutes < 600) { sessionText = 'Session: Judas Swing';  dotClass = 'dot yellow'; }
        else if (totalMinutes >= 600 && totalMinutes < 690) { sessionText = 'Session: AM Kill Zone'; dotClass = 'dot pulse-green'; }
        else if (totalMinutes >= 690 && totalMinutes < 810) { sessionText = 'Session: Lunch Chop';   dotClass = 'dot yellow'; }
        else if (totalMinutes >= 810 && totalMinutes < 930) { sessionText = 'Session: PM Kill Zone'; dotClass = 'dot pulse-green'; }
        else if (totalMinutes >= 930 && totalMinutes < 960) { sessionText = 'Session: Power Hour';   dotClass = 'dot orange'; }

        uiSessionLabel.textContent = sessionText;
        uiSessionDot.className     = dotClass;
    }

    updateMarketClock();
    setInterval(updateMarketClock, 10000);

    // ── LOGOUT & REAL-TIME CLOCK ──────────────────────────────
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.removeItem('jwt_token');
            sessionStorage.removeItem('jwt_token');
            window.location.href = '/index.html';
        });
    }

    function updateRealtimeClock() {
        const uiRealtimeClock = document.getElementById('uiRealtimeClock');
        if (!uiRealtimeClock) return;

        const options = {
            timeZone: 'America/New_York',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            month: 'short',
            day: '2-digit'
        };
        
        const formatter = new Intl.DateTimeFormat('en-US', options);
        const formatted = formatter.format(new Date());
        const parts = formatted.split(', ');
        
        if (parts.length === 3) {
            const timeParts = parts[2].split(' ');
            const timeVal = timeParts[0];
            const amPm = timeParts[1];
            
            if (!uiRealtimeClock.dataset.initialized) {
                uiRealtimeClock.innerHTML = `
                    <div style="color: #e3e3e3; padding-bottom: 2px; display:flex; align-items:center;">
                        <span id="uiClockDate"></span> 
                        <span id="uiClockDot" style="display:inline-block; width:6px; height:6px; border-radius:50%; background-color:rgba(255,255,255,0.3); margin-left:8px; transition: background-color 0.5s ease, box-shadow 0.5s ease;"></span>
                    </div>
                    <div><span id="uiClockTime" style="color: #66fcf1;"></span> <span id="uiClockAmPm" style="color: rgba(255,255,255,0.6);"></span></div>
                `;
                uiRealtimeClock.dataset.initialized = 'true';
            }
            
            document.getElementById('uiClockDate').textContent = `${parts[0]}, ${parts[1]}`;
            document.getElementById('uiClockTime').textContent = timeVal;
            document.getElementById('uiClockAmPm').textContent = `${amPm} ET`;
            
            const uiClockDot = document.getElementById('uiClockDot');
            if (events && events.length > 0 && uiClockDot) {
                const today = new Date();
                const cellDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                const nextDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
                const dayEvents = events.filter(e => e.date >= cellDate && e.date < nextDay);
                
                if (dayEvents.length > 0) {
                    const uniqueTypes = Array.from(new Set(dayEvents.map(e => e.type || 'default')));
                    const colors = uniqueTypes.map(t => CATEGORY_MAP[t] ? CATEGORY_MAP[t].color : '#f4b41a');
                    
                    const currentSecond = new Date().getSeconds();
                    const colorIndex = Math.floor(currentSecond / 2) % colors.length;
                    const activeColor = colors[colorIndex];
                    
                    uiClockDot.style.backgroundColor = activeColor;
                    uiClockDot.style.boxShadow = `0 0 4px ${activeColor}80`;
                } else {
                    uiClockDot.style.backgroundColor = 'rgba(255,255,255,0.3)';
                    uiClockDot.style.boxShadow = 'none';
                }
            }
        } else {
            uiRealtimeClock.innerHTML = formatted + " ET";
            uiRealtimeClock.dataset.initialized = '';
        }
    }

    setInterval(updateRealtimeClock, 1000);

    // Init
    loadAllEvents();

    // ── HEADER MINI CALENDAR WIDGET ENGINE ────────────────────
    // Mirrors the dashboard mini calendar so the header widget
    // works identically on the calendar page.
    const calMonthYear   = document.getElementById('calMonthYear');
    const calendarGrid   = document.getElementById('calendarGrid');
    const calTodayBtn    = document.getElementById('calTodayBtn');

    let currentCalDate = new Date();

    function renderMiniCalendar(dateToRender) {
        if (!calendarGrid || !calMonthYear) return;
        calendarGrid.innerHTML = '';

        const year  = dateToRender.getFullYear();
        const month = dateToRender.getMonth();
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        calMonthYear.textContent = `${monthNames[month]} ${year}`;

        const today = new Date();
        if (calTodayBtn) {
            if (year === today.getFullYear() && month === today.getMonth()) {
                calTodayBtn.classList.add('hidden');
            } else {
                calTodayBtn.classList.remove('hidden');
            }
        }

        const firstDayIndex  = new Date(year, month, 1).getDay();
        const totalDays      = new Date(year, month + 1, 0).getDate();
        const prevMonthDays  = new Date(year, month, 0).getDate();
        const isCurrentMonth = today.getMonth() === month && today.getFullYear() === year;
        const currentDay     = today.getDate();

        // Prev month filler
        for (let x = firstDayIndex; x > 0; x--) {
            const cell = document.createElement('div');
            cell.className = 'epic-cal-day faded';
            const idx = (firstDayIndex - x) % 7;
            if (idx === 0 || idx === 6) cell.classList.add('weekend');
            cell.textContent = prevMonthDays - x + 1;
            calendarGrid.appendChild(cell);
        }

        // Current month days
        for (let day = 1; day <= totalDays; day++) {
            const cell = document.createElement('div');
            cell.className = 'epic-cal-day';
            const dayIdx = new Date(year, month, day).getDay();
            if (dayIdx === 0 || dayIdx === 6) cell.classList.add('weekend');
            cell.textContent = day;

            // Event dots from the main events array
            const cellDate = new Date(year, month, day);
            const nextDay  = new Date(year, month, day + 1);
            const dayEvts  = events.filter(e => e.date >= cellDate && e.date < nextDay);
            if (dayEvts.length > 0) {
                const uniqueTypes = [...new Set(dayEvts.map(e => e.type || 'default'))];
                const typeColors = {
                    'holiday':'#aa00ff','birthday':'#00e5ff','expense':'#1de9b6',
                    'income':'#39ff14','trade':'#2979ff','personal':'#f900a6',
                    'rollover':'#ffffff','default':'#f4b41a'
                };
                const colors = uniqueTypes.map(t => typeColors[t] || typeColors['default']);
                const indicators = document.createElement('div');
                indicators.className = 'epic-cal-indicators';
                const dot = document.createElement('div');
                dot.className = 'epic-cal-dot';
                dot.style.background  = colors[0];
                dot.style.boxShadow   = `0 0 4px ${colors[0]}`;
                indicators.appendChild(dot);
                if (!(isCurrentMonth && day === currentDay)) cell.appendChild(indicators);
            }

            if (isCurrentMonth && day === currentDay) cell.classList.add('today');
            calendarGrid.appendChild(cell);
        }

        // Next month filler (to fill 42 cells)
        const filled = firstDayIndex + totalDays;
        for (let j = 1; j <= 42 - filled; j++) {
            const cell = document.createElement('div');
            cell.className = 'epic-cal-day faded';
            const idx = new Date(year, month + 1, j).getDay();
            if (idx === 0 || idx === 6) cell.classList.add('weekend');
            cell.textContent = j;
            calendarGrid.appendChild(cell);
        }
    }

    // Overlay month/year picker (click on "June 2026" text in mini widget)
    const calMonthPickerOverlay = document.getElementById('calMonthPickerOverlay');
    const calMainBody           = document.getElementById('calMainBody');
    const calMonthGrid          = document.getElementById('calMonthGrid');
    const calYearGrid           = document.getElementById('calYearGrid');

    const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let overlayYear = currentCalDate.getFullYear();
    let overlayMode = 'closed';

    function renderOverlay() {
        if (!calMonthYear) return;
        if (calTodayBtn) calTodayBtn.classList.remove('hidden');

        if (overlayMode === 'months') {
            if (calYearGrid)  calYearGrid.classList.add('hidden');
            if (calMonthGrid) calMonthGrid.classList.remove('hidden');
            calMonthYear.textContent = overlayYear;
            calMonthGrid.innerHTML   = '';
            shortMonths.forEach((m, i) => {
                const btn = document.createElement('button');
                btn.className = 'epic-cal-month-btn';
                if (overlayYear === currentCalDate.getFullYear() && i === currentCalDate.getMonth()) btn.classList.add('selected');
                btn.textContent = m;
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    currentCalDate.setFullYear(overlayYear, i, 1);
                    renderMiniCalendar(currentCalDate);
                    closeOverlay();
                });
                calMonthGrid.appendChild(btn);
            });
        } else if (overlayMode === 'years') {
            if (calMonthGrid) calMonthGrid.classList.add('hidden');
            if (calYearGrid)  calYearGrid.classList.remove('hidden');
            const decadeStart = Math.floor(overlayYear / 10) * 10;
            calMonthYear.textContent = 'Year';
            calYearGrid.innerHTML    = '';
            for (let i = 0; i < 12; i++) {
                const y   = decadeStart + i;
                const btn = document.createElement('button');
                btn.className = 'epic-cal-month-btn';
                if (y === currentCalDate.getFullYear()) btn.classList.add('selected');
                btn.textContent = y;
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    overlayYear = y;
                    overlayMode = 'months';
                    renderOverlay();
                });
                calYearGrid.appendChild(btn);
            }
        }
    }

    function closeOverlay() {
        overlayMode = 'closed';
        if (calMonthPickerOverlay) calMonthPickerOverlay.classList.remove('active');
        if (calMainBody)           calMainBody.classList.remove('dimmed');
        renderMiniCalendar(currentCalDate);
    }

    if (calMonthYear && calMonthPickerOverlay) {
        calMonthYear.addEventListener('click', e => {
            e.stopPropagation();
            if (overlayMode === 'closed') {
                overlayMode = 'months';
                overlayYear = currentCalDate.getFullYear();
                renderOverlay();
                calMonthPickerOverlay.classList.add('active');
                if (calMainBody) calMainBody.classList.add('dimmed');
            } else if (overlayMode === 'months') {
                overlayMode = 'years';
                renderOverlay();
            }
        });

        document.addEventListener('click', e => {
            if (overlayMode !== 'closed' && calMonthPickerOverlay && !calMonthPickerOverlay.contains(e.target) && e.target !== calMonthYear) {
                closeOverlay();
            }
        });
    }

    if (calTodayBtn) {
        calTodayBtn.addEventListener('click', e => {
            e.stopPropagation();
            currentCalDate = new Date();
            renderMiniCalendar(currentCalDate);
            closeOverlay();
        });
    }

    // ── HEADER EVENTS PANEL + TAB SWITCHING ───────────────────
    function renderEventsPanel() {
        const now           = new Date();
        const startOfToday  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday    = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
        const endOfTomorrow = new Date(endOfToday);   endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
        const endOfNext7    = new Date(endOfTomorrow); endOfNext7.setDate(endOfNext7.getDate() + 6);

        const todayEvts   = events.filter(e => e.date >= startOfToday && e.date < endOfToday);
        const tomorrowEvts= events.filter(e => e.date >= endOfToday   && e.date < endOfTomorrow);
        const next7Evts   = events.filter(e => e.date >= endOfTomorrow && e.date < endOfNext7);

        function fillList(listEl, evts) {
            if (!listEl) return;
            if (evts.length === 0) { listEl.innerHTML = '<div class="epic-event-empty">No events scheduled.</div>'; return; }
            listEl.innerHTML = evts.slice(0, 4).map(e => {
                const conf = CATEGORY_MAP[e.type] || CATEGORY_MAP['personal'];
                return `<li class="event-type-${e.type}" style="padding:6px 0;display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(255,255,255,0.04);">
                    <span style="color:${conf.color};font-size:0.8rem;">${conf.emoji}</span>
                    <span style="font-size:0.82rem;color:#e3e3e3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</span>
                </li>`;
            }).join('');
        }

        fillList(document.getElementById('eventsTodayList'),    todayEvts);
        fillList(document.getElementById('eventsTomorrowList'), tomorrowEvts);
        fillList(document.getElementById('eventsNext7DaysList'),next7Evts);

        // Tab switching
        document.querySelectorAll('.epic-event-tab').forEach(tab => {
            tab.addEventListener('mouseenter', () => {
                document.querySelectorAll('.epic-event-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.epic-events-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                const target = document.getElementById('tab-' + tab.dataset.tab);
                if (target) target.classList.add('active');
            });
        });
    }

    // Initial mini calendar + events render (called after loadAllEvents populates `events`)
    const _origLoadAllEvents = loadAllEvents;
    async function loadAllEventsAndSync() {
        await _origLoadAllEvents();
        renderMiniCalendar(currentCalDate);
        renderEventsPanel();
    }
    // Override the init call at the bottom to use the synced version
    loadAllEventsAndSync();

    // ── DAY DETAIL MODAL ENGINE ─────────────────────────────────
    const dayModalOverlay   = document.getElementById('dayModal');
    const dayModalCloseBtn  = document.getElementById('dayModalClose');
    const dayModalDow       = document.getElementById('dayModalDow');
    const dayModalDateTxt   = document.getElementById('dayModalDate');
    const dayEventsList     = document.getElementById('dayEventsList');
    const dayAddForm        = document.getElementById('dayAddEventForm');
    const dayEventTitleInp  = document.getElementById('dayEventTitle');
    const dayEventRecurring = document.getElementById('dayEventRecurring');
    const recurrenceOptions = document.getElementById('recurrenceOptions');

    // End-date picker elements
    const dayEndTrigger   = document.getElementById('dayEndTrigger');
    const dayEndTriggerTx = document.getElementById('dayEndTriggerText');
    const dayEndDropdown  = document.getElementById('dayEndDropdown');
    const dayEndHeader    = document.getElementById('dayEndHeader');
    const dayEndMonthGrid = document.getElementById('dayEndMonthGrid');
    const dayEndYearGrid  = document.getElementById('dayEndYearGrid');
    const dayEndTodayBtn  = document.getElementById('dayEndTodayBtn');

    const DOW_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    let selectedModalDate = null;
    let selectedEventType = null;
    let selectedFrequency = 'monthly';
    let endsMode          = 'never';   // 'never' | 'on-date'
    let selectedEndDate   = null;      // Date object (1st of selected month)
    let endPickerYear     = new Date().getFullYear();
    let selectedAccountId = null;      // UUID of chosen financial account

    // ── Financial Accounts ────────────────────────────────────────
    async function loadFinancialAccounts(type) {
        const sel = document.getElementById('dayEventAccount');
        if (!sel) return;
        sel.innerHTML = '<option value="">— Loading… —</option>';
        try {
            const res = await fetch(`/api/auth/trading/financial-accounts?type=${type}`, { headers: API_HEADERS });
            if (res.status === 401) {
                localStorage.removeItem('jwt_token');
                sessionStorage.removeItem('jwt_token');
                window.location.href = '/index.html';
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const accounts = await res.json();
            if (!Array.isArray(accounts)) throw new Error('Unexpected response');
            if (accounts.length === 0) {
                sel.innerHTML = '<option value="">— No accounts yet —</option>';
            } else {
                sel.innerHTML = '<option value="">— Select account —</option>';
                accounts.forEach(a => {
                    const opt = document.createElement('option');
                    opt.value = a.id;
                    opt.textContent = a.account_name;
                    sel.appendChild(opt);
                });
            }
            selectedAccountId = null;
        } catch (err) {
            sel.innerHTML = `<option value="">— Error: ${err.message} —</option>`;
            console.error('loadFinancialAccounts error:', err);
        }
    }

    async function createFinancialAccount(account_name, account_type) {
        const res = await fetch('/api/auth/trading/financial-accounts', {
            method: 'POST',
            headers: API_HEADERS,
            body: JSON.stringify({ account_name, account_type })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to create account');
        }
        return res.json();
    }

    let endPickerMode     = 'closed';  // 'closed' | 'months' | 'years'

    // Never caps per frequency
    const NEVER_CAPS = { weekly: 26, biweekly: 26, monthly: 36, yearly: 10 };

    function openDayModal(cellDate, dayEvents) {
        selectedModalDate = new Date(cellDate);
        selectedEventType = null;
        selectedFrequency = 'monthly';
        endsMode          = 'never';
        selectedEndDate   = null;
        endPickerMode     = 'closed';

        dayModalDow.textContent     = DOW_NAMES[cellDate.getDay()];
        dayModalDateTxt.textContent = `${MONTH_NAMES[cellDate.getMonth()]} ${cellDate.getDate()}, ${cellDate.getFullYear()}`;

        switchDayTab('events');
        renderDayEventsList(dayEvents);

        if (dayAddForm) dayAddForm.reset();
        document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.freq-pill[data-freq]').forEach(p => p.classList.toggle('active', p.dataset.freq === 'monthly'));
        document.querySelectorAll('.freq-pill[data-ends]').forEach(p => p.classList.toggle('active', p.dataset.ends === 'never'));
        // Reset all type-specific fields to hidden; syncFormFields will show correct ones once type is picked
        selectedEventType = null;
        selectedAccountId = null;
        ['fieldName','fieldAccount','fieldAmount'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const recurringRow = document.querySelector('.recurring-toggle-row');
        if (recurringRow) recurringRow.style.display = '';
        if (recurrenceOptions) recurrenceOptions.classList.add('hidden');
        const epg = document.getElementById('endDatePickerGroup');
        if (epg) epg.classList.add('hidden');
        if (dayEndDropdown)  dayEndDropdown.classList.add('hidden');
        if (dayEndTrigger)   dayEndTrigger.classList.remove('open','has-value');
        if (dayEndTriggerTx) dayEndTriggerTx.textContent = 'Select month';
        // Reset new-account UI
        const nRow = document.getElementById('newAccountRow');
        const nTog = document.getElementById('addAccountToggle');
        const nInp = document.getElementById('newAccountName');
        if (nRow) nRow.classList.add('hidden');
        if (nTog) nTog.textContent = '+ New account';
        if (nInp) nInp.value = '';

        dayModalOverlay.classList.remove('hidden');
        requestAnimationFrame(() => dayModalOverlay.classList.add('active'));
    }

    function closeDayModal() {
        dayModalOverlay.classList.remove('active');
        setTimeout(() => dayModalOverlay.classList.add('hidden'), 320);
    }

    function renderDayEventsList(dayEvents) {
        if (!dayEventsList) return;
        if (!dayEvents || dayEvents.length === 0) {
            dayEventsList.innerHTML = `
                <div class="day-no-events">
                    <div class="day-no-events-icon">💭</div>
                    <div class="day-no-events-text">No events scheduled for this day</div>
                </div>`;
            return;
        }
        dayEventsList.innerHTML = dayEvents.map(e => {
            const conf = CATEGORY_MAP[e.type] || { color: '#888', emoji: '📅', label: e.type };
            const amtStr = e.amount != null
                ? ` — $${parseFloat(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : (e.event_type === 'income' || e.event_type === 'expense') ? ' · <em style="opacity:.45;font-size:.8em">Reminder</em>' : '';
            return `
                <div class="day-event-item">
                    <div class="day-event-dot" style="background:${conf.color}; box-shadow:0 0 6px ${conf.color}55;"></div>
                    <div class="day-event-info">
                        <div class="day-event-name">${conf.emoji} ${e.title}${amtStr}</div>
                        <div class="day-event-cat">${conf.label}</div>
                    </div>
                </div>`;
        }).join('');
    }

    function switchDayTab(tab) {
        document.querySelectorAll('.day-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.getElementById('tabEvents').classList.toggle('active', tab === 'events');
        document.getElementById('tabAdd').classList.toggle('active',   tab === 'add');
    }

    document.querySelectorAll('.day-tab-btn').forEach(btn => btn.addEventListener('click', () => switchDayTab(btn.dataset.tab)));

    if (dayModalCloseBtn) dayModalCloseBtn.addEventListener('click', closeDayModal);
    if (dayModalOverlay)  dayModalOverlay.addEventListener('click', e => { if (e.target === dayModalOverlay) closeDayModal(); });

    // Helper: sync field visibility based on current type + recurring state
    function syncFormFields(typeChanged = false) {
        const isBirthday   = selectedEventType === 'birthday';
        const isMoney      = selectedEventType === 'income' || selectedEventType === 'expense';
        const isRecurOn    = dayEventRecurring && dayEventRecurring.checked;
        const recurringRow = document.querySelector('.recurring-toggle-row');

        // Name: birthday only
        const fName = document.getElementById('fieldName');
        if (fName) fName.classList.toggle('hidden', !isBirthday);

        // Account: income/expense only
        const fAcct = document.getElementById('fieldAccount');
        if (fAcct) fAcct.classList.toggle('hidden', !isMoney);

        // Amount: income/expense AND NOT recurring (Option C — recurring = reminder only)
        const fAmt = document.getElementById('fieldAmount');
        if (fAmt) fAmt.classList.toggle('hidden', !isMoney || isRecurOn);

        // Recurring row: hidden for birthday
        if (recurringRow) recurringRow.style.display = isBirthday ? 'none' : '';

        // Recurrence options panel
        if (recurrenceOptions) recurrenceOptions.classList.toggle('hidden', isBirthday || !isRecurOn);

        // Load accounts when type changes to a money type
        if (typeChanged && isMoney) loadFinancialAccounts(selectedEventType);
    }

    document.querySelectorAll('.type-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            selectedEventType = pill.dataset.type;
            syncFormFields(true);  // true = type just changed
        });
    });

    if (dayEventRecurring) {
        dayEventRecurring.addEventListener('change', () => syncFormFields(false));
    }

    // Track selected account_id
    const acctSelect = document.getElementById('dayEventAccount');
    if (acctSelect) {
        acctSelect.addEventListener('change', () => {
            selectedAccountId = acctSelect.value || null;
        });
    }

    // + New account inline toggle
    const addToggle   = document.getElementById('addAccountToggle');
    const newAcctRow  = document.getElementById('newAccountRow');
    const newAcctName = document.getElementById('newAccountName');
    const newAcctSave = document.getElementById('newAccountSaveBtn');

    if (addToggle) {
        addToggle.addEventListener('click', () => {
            const isOpen = !newAcctRow.classList.contains('hidden');
            newAcctRow.classList.toggle('hidden', isOpen);
            addToggle.textContent = isOpen ? '+ New account' : '− Cancel';
            if (!isOpen && newAcctName) newAcctName.focus();
        });
    }

    if (newAcctSave) {
        newAcctSave.addEventListener('click', async () => {
            const name = newAcctName ? newAcctName.value.trim() : '';
            if (!name) { newAcctName && newAcctName.focus(); return; }
            if (!selectedEventType || !['income','expense'].includes(selectedEventType)) return;
            try {
                newAcctSave.disabled = true;
                newAcctSave.textContent = '…';
                const acct = await createFinancialAccount(name, selectedEventType);
                // Reload dropdown and select the new account
                await loadFinancialAccounts(selectedEventType);
                const sel = document.getElementById('dayEventAccount');
                if (sel) { sel.value = acct.id; selectedAccountId = acct.id; }
                // Close the row
                if (newAcctRow) newAcctRow.classList.add('hidden');
                if (addToggle)  addToggle.textContent = '+ New account';
                if (newAcctName) newAcctName.value = '';
            } catch (err) {
                alert(err.message);
            } finally {
                if (newAcctSave) { newAcctSave.disabled = false; newAcctSave.textContent = 'Add'; }
            }
        });
    }

    // Frequency pills (data-freq only — separate from Ends pills)
    document.querySelectorAll('.freq-pill[data-freq]').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.freq-pill[data-freq]').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            selectedFrequency = pill.dataset.freq;
        });
    });

    // Ends pills — Never / On Date
    document.querySelectorAll('.freq-pill[data-ends]').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.freq-pill[data-ends]').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            endsMode = pill.dataset.ends;
            const epg = document.getElementById('endDatePickerGroup');
            if (epg) epg.classList.toggle('hidden', endsMode !== 'on-date');
        });
    });

    // ── End-month inline picker (same logic as main-cal-picker) ──
    function renderEndPicker() {
        if (endPickerMode === 'months') {
            if (dayEndYearGrid)  dayEndYearGrid.classList.add('hidden');
            if (dayEndMonthGrid) dayEndMonthGrid.classList.remove('hidden');
            if (dayEndHeader)    dayEndHeader.textContent = endPickerYear;
            if (!dayEndMonthGrid) return;
            dayEndMonthGrid.innerHTML = '';
            SHORT_MONTHS.forEach((m, i) => {
                const btn = document.createElement('button');
                btn.type = 'button'; btn.className = 'main-cal-btn';
                if (selectedEndDate && endPickerYear === selectedEndDate.getFullYear() && i === selectedEndDate.getMonth()) btn.classList.add('selected');
                btn.textContent = m;
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    selectedEndDate = new Date(endPickerYear, i, 1);
                    if (dayEndTriggerTx) dayEndTriggerTx.textContent = `${MONTH_NAMES[i]} ${endPickerYear}`;
                    if (dayEndTrigger)   dayEndTrigger.classList.add('has-value');
                    closeEndPicker();
                });
                dayEndMonthGrid.appendChild(btn);
            });
        } else if (endPickerMode === 'years') {
            if (dayEndMonthGrid) dayEndMonthGrid.classList.add('hidden');
            if (dayEndYearGrid)  dayEndYearGrid.classList.remove('hidden');
            if (dayEndHeader)    dayEndHeader.textContent = 'Year';
            if (!dayEndYearGrid) return;
            const dStart = Math.floor(endPickerYear / 10) * 10;
            dayEndYearGrid.innerHTML = '';
            for (let i = 0; i < 12; i++) {
                const y = dStart + i;
                const btn = document.createElement('button');
                btn.type = 'button'; btn.className = 'main-cal-btn';
                if (selectedEndDate && y === selectedEndDate.getFullYear()) btn.classList.add('selected');
                btn.textContent = y;
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    endPickerYear = y; endPickerMode = 'months'; renderEndPicker();
                });
                dayEndYearGrid.appendChild(btn);
            }
        }
    }

    function closeEndPicker() {
        endPickerMode = 'closed';
        if (dayEndDropdown) dayEndDropdown.classList.add('hidden');
        if (dayEndTrigger)  dayEndTrigger.classList.remove('open');
    }

    if (dayEndTrigger) {
        dayEndTrigger.addEventListener('click', e => {
            e.stopPropagation();
            if (endPickerMode === 'closed') {
                endPickerMode = 'months';
                endPickerYear = selectedEndDate ? selectedEndDate.getFullYear() : new Date().getFullYear();
                renderEndPicker();
                if (dayEndDropdown) dayEndDropdown.classList.remove('hidden');
                dayEndTrigger.classList.add('open');
            } else { closeEndPicker(); }
        });
    }
    if (dayEndHeader) {
        dayEndHeader.addEventListener('click', e => {
            e.stopPropagation();
            if (endPickerMode === 'months') { endPickerMode = 'years'; renderEndPicker(); }
        });
    }
    if (dayEndTodayBtn) {
        dayEndTodayBtn.addEventListener('click', e => {
            e.stopPropagation();
            const now = new Date();
            selectedEndDate = new Date(now.getFullYear(), now.getMonth(), 1);
            if (dayEndTriggerTx) dayEndTriggerTx.textContent = `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
            if (dayEndTrigger)   dayEndTrigger.classList.add('has-value');
            closeEndPicker();
        });
    }
    document.addEventListener('click', e => {
        const pk = document.getElementById('dayEndPicker');
        if (endPickerMode !== 'closed' && pk && !pk.contains(e.target)) closeEndPicker();
    });

    // ── Form submit ────────────────────────────────────────────
    if (dayAddForm) {
        dayAddForm.addEventListener('submit', async e => {
            e.preventDefault();
            if (!selectedEventType) { alert('Please select an event type.'); return; }

            const isBirthday = selectedEventType === 'birthday';
            const isMoney    = selectedEventType === 'income' || selectedEventType === 'expense';

            // Get title/account value based on type
            let title;
            if (isBirthday) {
                title = dayEventTitleInp ? dayEventTitleInp.value.trim() : '';
                if (!title) { alert('Please enter a name.'); return; }
            } else {
                // For income/expense: use selected account
                const acctEl = document.getElementById('dayEventAccount');
                const acctId = acctEl ? acctEl.value : '';
                if (!acctId) { alert('Please select an account.'); return; }
                selectedAccountId = acctId;
                // Get the account name from the selected option text
                title = acctEl.options[acctEl.selectedIndex]?.text || acctId;
            }

            // Amount — only for non-recurring money events (Option C)
            const isRecurringOn = dayEventRecurring && dayEventRecurring.checked;
            let amount = null;
            if (isMoney && !isRecurringOn) {
                const amtEl = document.getElementById('dayEventAmount');
                amount = amtEl ? (parseFloat(amtEl.value) || null) : null;
            }

            // Birthdays auto-expand as yearly/never — no user input needed
            const isRecurring   = isBirthday || isRecurringOn;
            const effectiveFreq = isBirthday ? 'yearly' : selectedFrequency;
            const effectiveEnds = isBirthday ? 'never'  : endsMode;
            const startD        = selectedModalDate;
            const datesToSave   = [new Date(startD)];

            if (isRecurring) {
                let curr = new Date(startD);
                if (effectiveEnds === 'on-date' && selectedEndDate) {
                    const endD = new Date(selectedEndDate.getFullYear(), selectedEndDate.getMonth() + 1, 0);
                    while (datesToSave.length < 60) {
                        if      (effectiveFreq === 'weekly')   curr.setDate(curr.getDate() + 7);
                        else if (effectiveFreq === 'biweekly') curr.setDate(curr.getDate() + 14);
                        else if (effectiveFreq === 'monthly')  curr.setMonth(curr.getMonth() + 1);
                        else if (effectiveFreq === 'yearly')   curr.setFullYear(curr.getFullYear() + 1);
                        if (curr > endD) break;
                        datesToSave.push(new Date(curr));
                    }
                } else {
                    // Never — frequency-based cap
                    const cap = NEVER_CAPS[effectiveFreq] || 10;
                    while (datesToSave.length <= cap) {
                        if      (effectiveFreq === 'weekly')   curr.setDate(curr.getDate() + 7);
                        else if (effectiveFreq === 'biweekly') curr.setDate(curr.getDate() + 14);
                        else if (effectiveFreq === 'monthly')  curr.setMonth(curr.getMonth() + 1);
                        else if (effectiveFreq === 'yearly')   curr.setFullYear(curr.getFullYear() + 1);
                        datesToSave.push(new Date(curr));
                    }
                }
            }

            try {
                await Promise.all(datesToSave.map(d => {
                    const event_date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12)).toISOString();
                    return fetch('/api/auth/trading/custom-events', {
                        method: 'POST', headers: API_HEADERS,
                        body: JSON.stringify({
                            title,
                            event_date,
                            event_type: selectedEventType,
                            ...(amount !== null ? { amount } : {}),
                            ...(selectedAccountId ? { account_id: selectedAccountId } : {})
                        })
                    });
                }));
                await loadAllEventsAndSync();
                closeDayModal();
            } catch (err) { console.error('Error saving event:', err); }
        });
    }
});
