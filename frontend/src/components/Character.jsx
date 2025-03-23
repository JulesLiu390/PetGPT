import React, { useEffect, useRef, useState } from 'react';
import { CharacterImage } from '../assets';
import { useStateValue } from '../content/StateProvider';
import { FaRocketchat } from "react-icons/fa";
import { CgAdd } from "react-icons/cg";
import {motion} from "framer-motion"



export const Character = () => {
    const [{characterMood}, dispatch] = useStateValue();
    const [isShowOptions, setIsShowOptions] = useState(false)


  const [imgSrc, setImgSrc] = useState('../assets/sample-normal.png');
  const handleClick = () => {
    window.electron?.changeChatWindow();
  }

  const handleClickAddCharacter = () => {
    window.electron?.changeAddCharacterWindow();
  }

  useEffect(() => {
    console.log("Character useEffect triggered with characterMood:", characterMood);
    import(`../assets/sample-${characterMood}.png`)
      .then(module => {
        setImgSrc(module.default);
      })
      .catch(err => {
        console.error('Failed to load image:', err);
      });
  }, [characterMood]);


//   img
const [isHovering, setIsHovering] = useState(false);


  return (
    <div className='select-none h-[300px] w-[200px] flex flex-col justify-center items-center'
    onMouseEnter={() => setIsShowOptions(true)}
    onMouseLeave={() => setIsShowOptions(false)}
    >
      <div className='h-[50px] w-full'>
      {isShowOptions && (
  <motion.div className="flex justify-evenly items-center gap-2 py-2"
  initial={{ opacity: 0, y: -10 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: -10 }}
  transition={{ duration: 0.3 }}
  >
    <FaRocketchat
      title="打开聊天窗口"
      onClick={handleClick}
      className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
    />
    <CgAdd
      title="发送表情"
      onClick={handleClickAddCharacter}
      className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
    />
    <FaRocketchat
      title="查看历史消息"
      className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
    />
    <FaRocketchat
      title="设置机器人语气"
      className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
    />
  </motion.div>
)}
      </div>


    <img 
      src={imgSrc}
      draggable="false"
      alt="character"
      background-size="cover"
      className="w-[200px] h-[200px] pointer-events-none"
    />

    <div
      className="w-[120px] h-[8px] rounded-full bg-gray-400 opacity-70 shadow-sm draggable"
    />

</div>
  );
};

export default Character;