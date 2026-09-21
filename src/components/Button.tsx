import { forwardRef, type ButtonHTMLAttributes } from 'react';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', className = '', type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} data-variant={variant} className={`ff-button ${className}`.trim()} {...props} />;
});
