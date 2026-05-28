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
    const grid = document.getElementById('fullCalendarGrid');
    const monthTrigger = document.getElementById('monthDropdownTrigger');
    const monthMenu = document.getElementById('monthDropdownMenu');
    const yearTrigger = document.getElementById('yearDropdownTrigger');
    const yearMenu = document.getElementById('yearDropdownMenu');
    const monthDropdown = document.getElementById('monthDropdown');
    const yearDropdown = document.getElementById('yearDropdown');
    const todayBtn = document.getElementById('calTodayFullBtn');
    
    // Modal Elements
    const addEventBtn = document.getElementById('addEventBtn');
    const modal = document.getElementById('addEventModal');
    const closeBtn = document.getElementById('closeEventModal');
    const form = document.getElementById('addEventForm');

    // Mappings
    const CATEGORY_MAP = {
        'income': { color: '#39ff14', emoji: '💵', label: 'Income' },
        'birthday': { color: '#00e5ff', emoji: '🎂', label: 'Birthday' },
        'expense': { color: '#1de9b6', emoji: '💳', label: 'Expense' },
        'trade': { color: '#2979ff', emoji: '📈', label: 'Prop Firm' },
        'personal': { color: '#f900a6', emoji: '🚩', label: 'Personal' },
        'rollover': { color: '#ffffff', emoji: '🔄', label: 'Rollover' },
        'holiday': { color: '#aa00ff', emoji: '🎆', label: 'Holiday' }
    };

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

        monthTrigger.textContent = months[month];
        yearTrigger.textContent = year;

        // Highlight selected items
        document.querySelectorAll('.dropdown-item').forEach(el => el.classList.remove('selected'));
        const mItem = document.querySelector(`.dropdown-item[data-type="month"][data-value="${month}"]`);
        if (mItem) mItem.classList.add('selected');
        const yItem = document.querySelector(`.dropdown-item[data-type="year"][data-value="${year}"]`);
        if (yItem) yItem.classList.add('selected');

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

            dayEvents.forEach(e => {
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

    // Dropdown Handlers
    function closeDropdowns(e) {
        if (!monthDropdown.contains(e.target)) monthDropdown.classList.remove('active');
        if (!yearDropdown.contains(e.target)) yearDropdown.classList.remove('active');
    }
    
    document.addEventListener('click', closeDropdowns);

    monthTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        yearDropdown.classList.remove('active');
        monthDropdown.classList.toggle('active');
    });

    yearTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        monthDropdown.classList.remove('active');
        yearDropdown.classList.toggle('active');
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

    // Initialize Custom Dropdowns
    const monthsList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    monthsList.forEach((m, i) => {
        const div = document.createElement('div');
        div.className = 'dropdown-item';
        div.dataset.type = 'month';
        div.dataset.value = i;
        div.textContent = m;
        div.addEventListener('click', () => {
            currentDate.setMonth(i);
            renderCalendar();
            monthDropdown.classList.remove('active');
        });
        monthMenu.appendChild(div);
    });

    const currYear = new Date().getFullYear();
    for (let y = currYear - 5; y <= currYear + 5; y++) {
        const div = document.createElement('div');
        div.className = 'dropdown-item';
        div.dataset.type = 'year';
        div.dataset.value = y;
        div.textContent = y;
        div.addEventListener('click', () => {
            currentDate.setFullYear(y);
            renderCalendar();
            yearDropdown.classList.remove('active');
        });
        yearMenu.appendChild(div);
    }

    // Init
    loadAllEvents();
});
