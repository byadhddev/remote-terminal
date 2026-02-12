export default function NotFound() {
    return (
        <div className="fixed inset-0 bg-[#1c1917] flex items-center justify-center">
            <div className="text-center">
                <h1 className="text-4xl font-bold text-[#e7e5e4] mb-2">404</h1>
                <p className="text-[#9b9a97] text-sm">
                    <a href="/terminal" className="text-[#D80018] hover:underline">Go to Terminal</a>
                </p>
            </div>
        </div>
    );
}
