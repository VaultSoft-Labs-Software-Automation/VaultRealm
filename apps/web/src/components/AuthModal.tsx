import { useState, useEffect, type FormEvent } from 'react';
import { api, type User, type ApiError } from '../api/client';
import { useToast } from './Toast';

interface AuthModalProps {
  needsSetup: boolean;
  onSuccess: (user: User) => void;
}

export function AuthModal({ needsSetup, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(needsSetup ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  const { addToast } = useToast();

  useEffect(() => {
    if (needsSetup) {
      setMode('register');
    }
  }, [needsSetup]);

  const isRegistering = needsSetup || mode === 'register';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (!isRegistering) {
        const user = await api.login(username || email, password);
        addToast({ type: 'success', title: `Welcome back, ${user.username}!` });
        onSuccess(user);
      } else {
        const user = await api.register({
          email,
          username,
          password,
          inviteCode: needsSetup ? undefined : inviteCode,
        });
        addToast({
          type: 'success',
          title: needsSetup ? 'Admin account created!' : 'Account registered successfully!',
        });
        onSuccess(user);
      }
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: !isRegistering ? 'Login Failed' : 'Registration Failed',
        message: error.message,
        details: error.details,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-3 sm:p-4 animate-fade-in overflow-y-auto">
      <div className="card max-w-md w-full p-5 sm:p-8 border border-border shadow-2xl relative glow-primary my-auto">
        <div className="text-center mb-6">
          <img
            src="/VR2.jpg"
            alt="VaultRealm"
            className="h-14 w-auto object-contain mx-auto mb-4 rounded-xl shadow-md border border-border/50"
          />
          <h2 className="text-2xl font-bold gradient-text">
            {needsSetup
              ? 'Welcome to VaultRealm'
              : mode === 'login'
                ? 'Sign in to VaultRealm'
                : 'Join the Realm'}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {needsSetup
              ? 'Create the primary administrator account to get started'
              : mode === 'login'
                ? 'Enter your credentials to access your servers'
                : 'Enter your invite code to deploy game servers'}
          </p>
        </div>

        {!needsSetup && (
          <div className="flex border border-border rounded-lg p-1 mb-6 bg-muted/40">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                mode === 'login'
                  ? 'bg-primary text-primary-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                mode === 'register'
                  ? 'bg-primary text-primary-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Register
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegistering && (
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                className="input w-full"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
              {isRegistering ? 'Username' : 'Email or Username'}
            </label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={isRegistering ? 'admin' : 'e.g. gamekeeper'}
              className="input w-full"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="input w-full"
            />
          </div>

          {isRegistering && !needsSetup && (
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                Invite Code
              </label>
              <input
                type="text"
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Enter your invite code"
                className="input w-full font-mono uppercase"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary w-full py-2.5 mt-2 flex items-center justify-center font-semibold"
          >
            {loading ? (
              <span className="inline-block animate-spin mr-2">⟳</span>
            ) : needsSetup ? (
              'Initialize Admin Realm'
            ) : !isRegistering ? (
              'Sign In'
            ) : (
              'Create Account'
            )}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-border/60 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5 font-mono">
          <span>Engineered by</span>
          <a
            href="https://www.vaultsoftlabs.tech/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground hover:text-primary transition-colors inline-flex items-center gap-0.5"
          >
            <span>VaultSoft Labs</span>
            <span className="text-[10px] text-primary">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}
