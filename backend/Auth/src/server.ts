import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Placeholder API Routes to power the UI
const apiRouter = express.Router();

apiRouter.post('/signup', (req, res) => {
    console.log(`[AUTH] Mock signup for ${req.body.email}`);
    res.status(201).json({ message: 'Account created. OTP sent to terminal.' });
});

apiRouter.post('/verify-otp', (req, res) => {
    console.log(`[AUTH] OTP verified for ${req.body.email}`);
    res.status(200).json({ token: 'mock-jwt-token-12345' });
});

apiRouter.post('/resend-otp', (req, res) => {
    res.status(200).json({ message: 'OTP resent to terminal.' });
});

apiRouter.post('/login', (req, res) => {
    console.log(`[AUTH] Login success for ${req.body.email}`);
    res.status(200).json({ token: 'mock-jwt-token-12345' });
});

apiRouter.get('/me', (req, res) => {
    res.status(200).json({ 
        username: 'noctis25', 
        email: 'secure@xepic.com', 
        createdAt: new Date().toISOString() 
    });
});

apiRouter.post('/logout', (req, res) => {
    res.status(200).json({ message: 'Logged out successfully' });
});

app.use('/api/auth', apiRouter);

app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║    Auth Service Running                              ║`);
    console.log(`║    http://localhost:${PORT}                               ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
});
