document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token');
    if (!token) {
        window.location.href = '/index.html';
        return;
    }

    const API_HEADERS = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    let currentDate = new Date();
    let events = [];

    // DOM Elements
    const grid      = document.getElementById('fullCalendarGrid');
    const todayBtn  = document.getElementById('calTodayFullBtn');
    
    // Modal Elements
    const addEventBtn = document.getElementById('addEventBtn');
    const modal = document.getElementById('addEventModal');
    const closeBtn = document.getElementById('closeEventModal');
    const form = document.getElementById('addEventForm');

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

                if (e.isCustom) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'del-event-btn';
                    delBtn.innerHTML = '&times;';
                    delBtn.onclick = async (evt) => {
                        evt.stopPropagation();
                        if(confirm('Delete this event?')) {
                            await deleteEvent(e.id);
                        }
                    };
                    pill.appendChild(delBtn);
                }

                eventsContainer.appendChild(pill);
            });

            cell.appendChild(eventsContainer);
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

    // ── FILTER BUTTONS ────────────────────────────────────────
    document.querySelectorAll('.cal-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            document.querySelectorAll('.cal-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
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

    // ── MODAL & FORMS ─────────────────────────────────────────
    addEventBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('eventTitle').value;
        const dateVal = document.getElementById('eventDate').value;
        const type = document.getElementById('eventType').value;

        // Force time to 12:00 PM UTC to avoid timezone shifting issues
        const event_date = new Date(`${dateVal}T12:00:00Z`).toISOString();

        try {
            const res = await fetch('/api/auth/trading/custom-events', {
                method: 'POST',
                headers: API_HEADERS,
                body: JSON.stringify({ title, event_date, event_type: type })
            });

            if (res.ok) {
                modal.classList.add('hidden');
                form.reset();
                await loadAllEvents();
            } else {
                alert('Failed to save event');
            }
        } catch (err) {
            console.error('Error creating event:', err);
        }
    });

    async function deleteEvent(id) {
        try {
            const res = await fetch(`/api/auth/trading/custom-events/${id}`, {
                method: 'DELETE',
                headers: API_HEADERS
            });
            if (res.ok) {
                await loadAllEvents();
            }
        } catch (err) {
            console.error('Error deleting event:', err);
        }
    }

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
});

