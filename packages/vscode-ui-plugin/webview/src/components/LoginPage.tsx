/**
 * Login Page Component
 * 登录页面组件 - 在未登录时显示，提供登录按钮
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { CustomModelWizard } from './CustomModelWizard';
import './LoginPage.css';

interface LoginPageProps {
  onLoginStart: () => void;
  isLoggingIn: boolean;
  loginError?: string;
  // 新增：初始loading状态
  isCheckingAuth?: boolean;
  // 🎯 新增：取消登录回调
  onCancelLogin?: () => void;
}

// 登录超时时间（毫秒）
const LOGIN_TIMEOUT = 10000; // 10秒

/**
 * 登录页面组件
 * 参考CLI设计，显示简洁的登录界面
 */
export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginStart,
  isLoggingIn,
  loginError,
  isCheckingAuth = false,
  onCancelLogin
}) => {
  const { t } = useTranslation();
  const [showCancelButton, setShowCancelButton] = useState(false);
  const [loginStartTime, setLoginStartTime] = useState<number | null>(null);
  // 🟢 未登录也能添加自定义模型 — 本地开关，不拽住全局状态。
  const [isCustomModelWizardOpen, setIsCustomModelWizardOpen] = useState(false);

  // 监听登录状态变化，记录开始时间和设置超时检测
  useEffect(() => {
    if (isLoggingIn && !isCheckingAuth) {
      // 登录开始，记录时间
      setLoginStartTime(Date.now());
      setShowCancelButton(false);

      // 设置超时定时器
      const timer = setTimeout(() => {
        setShowCancelButton(true);
      }, LOGIN_TIMEOUT);

      return () => clearTimeout(timer);
    } else {
      // 登录结束或状态重置
      setLoginStartTime(null);
      setShowCancelButton(false);
    }
  }, [isLoggingIn, isCheckingAuth]);

  // 处理取消登录
  const handleCancelLogin = () => {
    setShowCancelButton(false);
    setLoginStartTime(null);
    // 🎯 正确的方式：通过props通知父组件重置状态，而不是刷新页面
    // 调用父组件的重置回调，让父组件重置登录状态
    onCancelLogin?.();
  };

  return (
    <div className="login-page">
      <div className="login-page__container">

        {/* 登录卡片 */}
        <div className="login-page__card">
          {isCheckingAuth ? (
            <>
              <h2 className="login-page__card-title">Checking Login Status...</h2>
              <p className="login-page__description">
                <span className="login-page__spinner"></span>
                Verifying your login information, please wait...
              </p>
            </>
          ) : (
            <>
              <h2 className="login-page__card-title">Welcome</h2>
              <p className="login-page__description">
                Click the button below to start login, we will open the authentication page in your browser
              </p>
            </>
          )}

          {/* 登录按钮 */}
          <button
            className="login-page__login-btn"
            onClick={onLoginStart}
            disabled={isLoggingIn || isCheckingAuth}
            style={{ display: isCheckingAuth ? 'none' : 'block' }}
          >
            {isLoggingIn ? (
              <>
                <span className="login-page__spinner"></span>
                Logging in...
              </>
            ) : (
              <>
                <span className="login-page__login-icon">🔐</span>
                Start Login
              </>
            )}
          </button>

          {/* 取消登录按钮 - 超时后显示 */}
          {showCancelButton && isLoggingIn && !isCheckingAuth && (
            <div className="login-page__cancel-container">
              <button
                className="login-page__cancel-btn"
                onClick={handleCancelLogin}
              >
                Cancel
              </button>
              <p className="login-page__cancel-hint">
                Haven't received authentication result? Click to cancel and retry
              </p>
            </div>
          )}

          {/* Login instructions - only show when not checking status */}
          {!isCheckingAuth && (
            <div className="login-page__help">
              <p className="login-page__help-text">
                💡 After login, you can:
              </p>
              <ul className="login-page__feature-list">
                <li>Have intelligent conversations with AI</li>
                <li>Get code analysis and suggestions</li>
                <li>Use advanced tool features</li>
                <li>Manage multiple sessions</li>
              </ul>
            </div>
          )}

          {/* Status indicators */}
          {isCheckingAuth && (
            <div className="login-page__status">
              <div className="login-page__status-line">
                <span className="login-page__status-icon">🔍</span>
                <span>Checking local authentication...</span>
              </div>
              <div className="login-page__status-line">
                <span className="login-page__status-icon">🌐</span>
                <span>Verifying server connection...</span>
              </div>
              <div className="login-page__status-line">
                <span className="login-page__status-icon">⚡</span>
                <span>Preparing your workspace</span>
              </div>
            </div>
          )}

          {isLoggingIn && !isCheckingAuth && (
            <div className="login-page__status">
              <div className="login-page__status-line">
                <span className="login-page__status-icon">🌐</span>
                <span>Authentication page opened in browser...</span>
              </div>
              <div className="login-page__status-line">
                <span className="login-page__status-icon">⏳</span>
                <span>Please complete authentication in your browser</span>
              </div>
              <div className="login-page__status-line">
                <span className="login-page__status-icon">🔒</span>
                <span>Will automatically return to VSCode after authentication</span>
              </div>
            </div>
          )}
        </div>

        {/* 底部信息 - 只在非检查状态时显示 */}
        {!isCheckingAuth && (
          <div className="login-page__footer">
            <p className="login-page__footer-text">
              DeepV Code uses secure OAuth2 authentication flow
            </p>
            <p className="login-page__footer-subtext">
              Your authentication information will be securely stored locally
            </p>

            {/* 🟢 未登录入口 — 用户可直接配置 EasyRouter / 第三方自定义模型，
                免去 OAuth 流程。已登录用户仍可在主界面 ModelSelector 末尾使用同一个向导。 */}
            <div className="login-page__custom-model-section">
              <p className="login-page__custom-model-hint">
                Or use your own API key (no DeepV login required):
              </p>
              <button
                type="button"
                className="login-page__custom-model-btn"
                onClick={() => setIsCustomModelWizardOpen(true)}
                disabled={isLoggingIn}
              >
                + Add Custom Model
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 🟢 自定义模型向导 — 直接 mount 在 LoginPage 内，无需登录态。 */}
      <CustomModelWizard
        isOpen={isCustomModelWizardOpen}
        onClose={() => setIsCustomModelWizardOpen(false)}
      />
    </div>
  );
};