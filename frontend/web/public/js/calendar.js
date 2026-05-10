document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/login.html';
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
    const monthYearTitle = document.getElementById('calCurrentMonthYear');
    const prevBtn = document.getElementById('calPrevMonth');
    const nextBtn = document.getElementById('calNextMonth');
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
        'fmp-red': { color: '#ff1744', emoji: '🔴', label: 'High Impact' },
        'fmp-yellow': { color: '#f4b41a', emoji: '🟡', label: 'Med Impact' },
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

            // Fetch FMP Events
            const fmpRes = await fetch('/api/auth/trading/events', { headers: API_HEADERS });
            const fmpData = fmpRes.ok ? await fmpRes.json() : [];
            const parsedFMP = fmpData.filter(e => e.impact === 'High' || e.impact === 'Medium').map(e => ({
                id: e.id || Math.random().toString(),
                title: e.event,
                date: new Date(e.date),
                type: e.impact === 'High' ? 'fmp-red' : 'fmp-yellow',
                isCustom: false
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

            events = [...parsedCustom, ...parsedFMP, ...holidays2026];
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

        monthYearTitle.textContent = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

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

            // Sort events: FMP Red > FMP Yellow > Custom Events
            dayEvents.sort((a, b) => {
                const getWeight = (type) => {
                    if (type === 'fmp-red') return 3;
                    if (type === 'fmp-yellow') return 2;
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
                let displayTitle = e.title;
                if (!e.isCustom && (e.type === 'fmp-red' || e.type === 'fmp-yellow')) {
                    // Format FMP time
                    const timeStr = e.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                    displayTitle = `[${timeStr}] ${e.title}`;
                } else if (e.isCustom && conf.emoji) {
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
    prevBtn.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar();
    });

    nextBtn.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar();
    });

    todayBtn.addEventListener('click', () => {
        currentDate = new Date();
        renderCalendar();
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

    // Init
    loadAllEvents();
});
